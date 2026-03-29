//! LZ4 + adaptive Huffman second-pass compression.
//!
//! [`Lz4Huffman`] compresses by running the standard LZ4 block compressor and
//! then applying a canonical Huffman pass over the resulting bytes.  The
//! Huffman code is built fresh from the actual byte-frequency distribution of
//! the LZ4 output and stored as a 256-byte header, so the decoder can
//! reconstruct the exact same tree with no pre-shared state.
//!
//! When Huffman would not reduce size (small inputs, already near-incompressible
//! data) a raw LZ4 block is emitted instead.
//!
//! Wire format (after the optional discriminant byte):
//! ```text
//! [flag: u8]
//! ── FLAG_RAW (0x00) ─────────────────────────────────
//! [lz4_block]
//! ── FLAG_HUFFMAN (0x01) ─────────────────────────────
//! [code_lengths: [u8; 256]]   one per symbol; 0 = absent
//! [lz4_block_len: u32 LE]     byte length of the decoded LZ4 block
//! [huffman_bits]              MSB-first, zero-padded to full byte
//! ```

use crate::{CompressionError, Compressor};
use alloc::vec::Vec;

/// LZ4 with an adaptive Huffman second pass.
///
/// Better compression ratio than plain [`Lz4`](crate::Lz4) on structured data;
/// suitable for accounts up to ~12 KB (same heap ceiling as plain LZ4).
pub struct Lz4Huffman;

const FLAG_RAW: u8 = 0x00;
const FLAG_HUFFMAN: u8 = 0x01;

/// `code_lengths` (256 B) + `lz4_block_len` (4 B).
const HUFF_HEADER: usize = 260;

/// Only attempt Huffman when the LZ4 block is large enough to amortise the header.
const HUFF_THRESHOLD: usize = HUFF_HEADER + 16;

impl Compressor for Lz4Huffman {
    const NAME: &'static str = "lz4_huffman";
    const DISCRIMINANT: u8 = 0x03;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        let lz4_block = lz4_flex::block::compress_prepend_size(input);

        if lz4_block.len() > HUFF_THRESHOLD {
            let mut freq = [0u32; 256];
            for &b in &lz4_block {
                freq[b as usize] += 1;
            }
            let lengths = build_lengths(&freq);
            let (codes, _) = build_codes(&lengths);
            let huff_bits = huff_encode(&lz4_block, &codes, &lengths);

            if huff_bits.len() + HUFF_HEADER < lz4_block.len() {
                let mut out = Vec::with_capacity(1 + HUFF_HEADER + huff_bits.len() + 1);
                #[cfg(feature = "discriminant")]
                out.push(Self::DISCRIMINANT);
                out.push(FLAG_HUFFMAN);
                out.extend_from_slice(&lengths);
                out.extend_from_slice(&(lz4_block.len() as u32).to_le_bytes());
                out.extend_from_slice(&huff_bits);
                return Ok(out);
            }
        }

        let mut out = Vec::with_capacity(1 + lz4_block.len() + 1);
        #[cfg(feature = "discriminant")]
        out.push(Self::DISCRIMINANT);
        out.push(FLAG_RAW);
        out.extend_from_slice(&lz4_block);
        Ok(out)
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        #[cfg(feature = "discriminant")]
        let input = match input.split_first() {
            Some((&d, rest)) if d == Self::DISCRIMINANT => rest,
            _ => return Err(CompressionError::DecompressFailed),
        };

        let (&flag, rest) = input
            .split_first()
            .ok_or(CompressionError::DecompressFailed)?;

        match flag {
            FLAG_RAW => lz4_flex::block::decompress_size_prepended(rest)
                .map_err(|_| CompressionError::DecompressFailed),

            FLAG_HUFFMAN => {
                if rest.len() < HUFF_HEADER {
                    return Err(CompressionError::DecompressFailed);
                }
                let mut lengths = [0u8; 256];
                lengths.copy_from_slice(&rest[..256]);
                let lz4_block_len =
                    u32::from_le_bytes(rest[256..260].try_into().unwrap()) as usize;
                let lz4_block = huff_decode(&rest[HUFF_HEADER..], &lengths, lz4_block_len)?;
                lz4_flex::block::decompress_size_prepended(&lz4_block)
                    .map_err(|_| CompressionError::DecompressFailed)
            }

            _ => Err(CompressionError::DecompressFailed),
        }
    }
}

// ── Huffman tree construction ─────────────────────────────────────────────────

/// Build canonical code lengths from byte frequencies.
///
/// Returns `lengths[sym]` = code length for `sym` (0 = absent, 1–15 = present).
/// Uses a simple O(n²) merge algorithm; fine for n ≤ 256.
///
/// Note: lengths are capped at 15 for symbols deeper than 15 in the tree, which
/// can in rare cases produce an overloaded Huffman code.  For all realistic Solana
/// LZ4 outputs the tree depth stays well below 15.
fn build_lengths(freq: &[u32; 256]) -> [u8; 256] {
    let n_active = freq.iter().filter(|&&f| f > 0).count();
    let mut lengths = [0u8; 256];

    if n_active == 0 {
        return lengths;
    }
    if n_active == 1 {
        for (i, &f) in freq.iter().enumerate() {
            if f > 0 {
                lengths[i] = 1;
                return lengths;
            }
        }
        unreachable!()
    }

    // Node pool.  Indices 0..256 = leaf nodes (leaf i = symbol i).
    // Indices 256..512 = internal nodes allocated during tree construction.
    // `u32::MAX` = inactive (merged or unused).
    const NONE: u16 = u16::MAX;
    let mut node_freq: Vec<u32> = alloc::vec![u32::MAX; 512];
    let mut parent: Vec<u16> = alloc::vec![NONE; 512];

    for i in 0..256usize {
        if freq[i] > 0 {
            node_freq[i] = freq[i];
        }
    }

    let mut pool_end = 256usize;
    let mut remaining = n_active;

    while remaining > 1 {
        let (i1, i2) = two_min(&node_freq[..pool_end]);
        let f1 = node_freq[i1];
        let f2 = node_freq[i2];
        node_freq[i1] = u32::MAX;
        node_freq[i2] = u32::MAX;

        let new = pool_end;
        pool_end += 1;
        node_freq[new] = f1.saturating_add(f2);
        parent[i1] = new as u16;
        parent[i2] = new as u16;
        remaining -= 1;
    }

    // Code length = depth in the tree.
    for sym in 0..256usize {
        if freq[sym] == 0 {
            continue;
        }
        let mut depth = 0u8;
        let mut node = sym;
        while parent[node] != NONE && depth < 15 {
            node = parent[node] as usize;
            depth += 1;
        }
        lengths[sym] = depth.max(1);
    }

    lengths
}

/// Return the indices of the two active (non-`u32::MAX`) minimum-frequency nodes.
fn two_min(pool: &[u32]) -> (usize, usize) {
    let (mut m1_f, mut m1_i) = (u32::MAX, 0usize);
    let (mut m2_f, mut m2_i) = (u32::MAX, 0usize);
    for (i, &f) in pool.iter().enumerate() {
        if f == u32::MAX {
            continue;
        }
        if f < m1_f {
            m2_f = m1_f;
            m2_i = m1_i;
            m1_f = f;
            m1_i = i;
        } else if f < m2_f {
            m2_f = f;
            m2_i = i;
        }
    }
    debug_assert!(m1_f != u32::MAX && m2_f != u32::MAX);
    (m1_i, m2_i)
}

/// Assign canonical codewords from code lengths (RFC 1951 §3.2.2).
///
/// Returns `(codes, max_len)`.  `codes[sym]` is the integer codeword
/// (right-aligned, MSB-first) of length `lengths[sym]`.
fn build_codes(lengths: &[u8; 256]) -> ([u32; 256], u8) {
    let max_len = *lengths.iter().max().unwrap_or(&0);

    let mut bl_count = [0u32; 16];
    for &l in lengths {
        if l > 0 {
            bl_count[l as usize] += 1;
        }
    }

    let mut next_code = [0u32; 16];
    let mut code = 0u32;
    for bits in 1..=15usize {
        code = (code + bl_count[bits - 1]) << 1;
        next_code[bits] = code;
    }

    let mut codes = [0u32; 256];
    for sym in 0..256 {
        let l = lengths[sym] as usize;
        if l > 0 {
            codes[sym] = next_code[l];
            next_code[l] += 1;
        }
    }

    (codes, max_len)
}

// ── Encoder ───────────────────────────────────────────────────────────────────

/// Huffman-encode `data` using `codes`/`lengths`.
/// Output is MSB-first, zero-padded to a full byte boundary.
fn huff_encode(data: &[u8], codes: &[u32; 256], lengths: &[u8; 256]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut buf: u64 = 0;
    let mut pending: u8 = 0;

    for &byte in data {
        let l = lengths[byte as usize];
        let c = codes[byte as usize] as u64;
        buf = (buf << l) | c;
        pending += l;
        while pending >= 8 {
            pending -= 8;
            out.push((buf >> pending) as u8);
            buf &= (1u64 << pending) - 1;
        }
    }
    if pending > 0 {
        out.push((buf << (8 - pending)) as u8);
    }
    out
}

// ── Decoder ───────────────────────────────────────────────────────────────────

/// Huffman-decode `bitstream` producing exactly `output_len` bytes.
///
/// Uses the canonical decoding algorithm: O(max_code_len) per symbol, no heap
/// lookup table.  All decoding state fits on the stack (~400 bytes).
fn huff_decode(
    bitstream: &[u8],
    lengths: &[u8; 256],
    output_len: usize,
) -> Result<Vec<u8>, CompressionError> {
    // ── Canonical decode tables (all stack-allocated) ─────────────────────────
    let mut bl_count = [0u16; 16];
    let mut first_code = [0u32; 16];
    let mut first_idx = [0u16; 16];

    for &l in lengths {
        if l > 0 {
            bl_count[l as usize] += 1;
        }
    }
    {
        let mut code = 0u32;
        let mut idx = 0u16;
        for bits in 1..=15usize {
            first_code[bits] = code;
            first_idx[bits] = idx;
            code = (code + bl_count[bits] as u32) << 1;
            idx = idx.saturating_add(bl_count[bits]);
        }
    }

    // Symbols ordered by (code_length, symbol_value) — mirrors canonical assignment.
    let mut ordered = [0u8; 256];
    let n_syms = {
        let mut tmp: Vec<u8> = (0u16..256u16)
            .filter(|&s| lengths[s as usize] > 0)
            .map(|s| s as u8)
            .collect();
        tmp.sort_unstable_by_key(|&s| (lengths[s as usize], s));
        for (i, &s) in tmp.iter().enumerate() {
            ordered[i] = s;
        }
        tmp.len()
    };

    let max_len = *lengths.iter().max().unwrap_or(&0) as usize;

    // ── Decode `output_len` symbols ───────────────────────────────────────────
    let mut out = Vec::with_capacity(output_len);
    let mut reader = BitReader::new(bitstream);

    for _ in 0..output_len {
        let mut cur = 0u32;
        let mut found = false;

        for bit_len in 1..=max_len {
            match reader.read_bit() {
                Some(b) => cur = (cur << 1) | b,
                None => return Err(CompressionError::DecompressFailed),
            }
            let cnt = bl_count[bit_len] as u32;
            if cnt > 0 && cur >= first_code[bit_len] && cur < first_code[bit_len] + cnt {
                let si = first_idx[bit_len] as usize + (cur - first_code[bit_len]) as usize;
                if si >= n_syms {
                    return Err(CompressionError::DecompressFailed);
                }
                out.push(ordered[si]);
                found = true;
                break;
            }
        }

        if !found {
            return Err(CompressionError::DecompressFailed);
        }
    }

    Ok(out)
}

// ── Bit reader ────────────────────────────────────────────────────────────────

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u8,
    remaining: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0, buf: 0, remaining: 0 }
    }

    /// Read the next bit (MSB first).  Returns `None` at end of stream.
    #[inline]
    fn read_bit(&mut self) -> Option<u32> {
        if self.remaining == 0 {
            if self.pos >= self.data.len() {
                return None;
            }
            self.buf = self.data[self.pos];
            self.pos += 1;
            self.remaining = 8;
        }
        self.remaining -= 1;
        Some(((self.buf >> self.remaining) & 1) as u32)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Compressor;

    fn flag_pos() -> usize {
        if cfg!(feature = "discriminant") { 1 } else { 0 }
    }

    #[test]
    fn roundtrip_empty() {
        let c = Lz4Huffman::compress(b"").unwrap();
        assert_eq!(Lz4Huffman::decompress(&c).unwrap(), b"");
    }

    #[test]
    fn roundtrip_short() {
        let input = b"Hello Solana!";
        let c = Lz4Huffman::compress(input).unwrap();
        assert_eq!(Lz4Huffman::decompress(&c).unwrap(), input);
    }

    #[test]
    fn raw_flag_for_small_input() {
        let c = Lz4Huffman::compress(b"tiny").unwrap();
        assert_eq!(c[flag_pos()], FLAG_RAW);
        assert_eq!(Lz4Huffman::decompress(&c).unwrap(), b"tiny");
    }

    /// Partially-repeated input: each 32-byte entry has a unique 4-byte counter +
    /// a fixed 28-byte template.  LZ4 cannot collapse this into one huge match
    /// because the counter changes each entry, so the LZ4 output is large enough
    /// to exceed HUFF_THRESHOLD.  The repeated template bytes create a skewed
    /// byte distribution in the LZ4 output that Huffman can exploit.
    fn varied_input() -> Vec<u8> {
        let mut v = Vec::with_capacity(500 * 32);
        for i in 0u32..500 {
            v.extend_from_slice(&i.to_le_bytes());
            v.extend_from_slice(b"========================"); // 24 bytes
        }
        v
    }

    #[test]
    fn huffman_flag_and_roundtrip_large() {
        let input = varied_input();
        let c = Lz4Huffman::compress(&input).unwrap();
        assert_eq!(
            c[flag_pos()],
            FLAG_HUFFMAN,
            "partially-repeated input must use FLAG_HUFFMAN"
        );
        assert_eq!(Lz4Huffman::decompress(&c).unwrap(), input);
    }

    #[test]
    fn huffman_beats_plain_lz4() {
        // Partially-repeated data: LZ4 output > HUFF_THRESHOLD and has skewed
        // byte distribution → Huffman reduces it further.
        let input = varied_input();
        let lz4_size = crate::Lz4::compress(&input).unwrap().len();
        let huff_c = Lz4Huffman::compress(&input).unwrap();
        assert_eq!(huff_c[flag_pos()], FLAG_HUFFMAN);
        assert!(
            huff_c.len() < lz4_size,
            "Lz4Huffman ({} B) must beat plain Lz4 ({} B)",
            huff_c.len(),
            lz4_size
        );
        assert_eq!(Lz4Huffman::decompress(&huff_c).unwrap(), input);
    }

    #[test]
    fn corrupt_header_returns_error() {
        let input = varied_input();
        let mut c = Lz4Huffman::compress(&input).unwrap();
        assert_eq!(c[flag_pos()], FLAG_HUFFMAN);
        // Zero out the code_lengths header — decoder sees all lengths = 0 → DecompressFailed.
        let hdr_start = flag_pos() + 1;
        for b in c[hdr_start..hdr_start + 256].iter_mut() {
            *b = 0;
        }
        assert!(Lz4Huffman::decompress(&c).is_err());
    }

    #[test]
    fn discriminant_is_unique() {
        assert_ne!(Lz4Huffman::DISCRIMINANT, crate::Lz4::DISCRIMINANT);
        assert_ne!(
            Lz4Huffman::DISCRIMINANT,
            crate::ChunkedLz4::<4096>::DISCRIMINANT
        );
        assert_eq!(Lz4Huffman::DISCRIMINANT, 0x03);
    }
}
