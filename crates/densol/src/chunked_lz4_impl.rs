// `_ = Self::CHUNK_SIZE_NONZERO` is intentional: it forces evaluation of the
// compile-time assertion that N > 0 for each monomorphisation.
#![allow(clippy::let_unit_value)]

use crate::{CompressionError, Compressor};
use alloc::vec::Vec;

/// Chunked LZ4 compression strategy.
///
/// Splits input into independent fixed-size chunks before compressing so that
/// on-chain code can decompress one chunk at a time (`decompress_chunk`),
/// staying within the SBF VM's 32 KB heap limit even for MB-scale accounts.
///
/// The wire format is N-agnostic: any `ChunkedLz4<M>` can decompress data
/// that was compressed with `ChunkedLz4<N>` for any N ≠ M.
///
/// Wire format (after the optional discriminant byte):
/// ```text
/// [chunk_count:  u32 LE]
/// [original_len: u32 LE]
/// --- index (chunk_count × 8 bytes) ---
/// [offset_i: u32 LE][compressed_len_i: u32 LE]
/// ...
/// --- data region ---
/// [lz4_block_0][lz4_block_1]...
/// ```
/// Offsets in the index are relative to the start of the data region.
pub struct ChunkedLz4<const CHUNK_SIZE: usize = 4096>;

impl<const N: usize> ChunkedLz4<N> {
    // Compile-time assertion: evaluated (and errors at compile time) when any
    // method of ChunkedLz4<0> is first monomorphised.
    const CHUNK_SIZE_NONZERO: () = assert!(N > 0, "CHUNK_SIZE must be greater than zero");

    /// Decompress a single chunk — the key on-chain API, O(chunk_size) heap.
    pub fn decompress_chunk(data: &[u8], chunk_idx: usize) -> Result<Vec<u8>, CompressionError> {
        _ = Self::CHUNK_SIZE_NONZERO;
        let data = strip_discriminant(data, <Self as Compressor>::DISCRIMINANT)?;
        let (chunk_count, _original_len) = parse_header(data)?;
        if chunk_idx >= chunk_count {
            return Err(CompressionError::DecompressFailed);
        }
        read_chunk(data, chunk_count, chunk_idx)
    }

    /// Read chunk count from header without decompressing anything.
    pub fn chunk_count(data: &[u8]) -> Result<usize, CompressionError> {
        _ = Self::CHUNK_SIZE_NONZERO;
        let data = strip_discriminant(data, <Self as Compressor>::DISCRIMINANT)?;
        let (chunk_count, _original_len) = parse_header(data)?;
        Ok(chunk_count)
    }
}

impl<const N: usize> Compressor for ChunkedLz4<N> {
    const NAME: &'static str = "chunked_lz4";
    const DISCRIMINANT: u8 = 0x02;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        _ = Self::CHUNK_SIZE_NONZERO;

        let chunk_count = input.len().div_ceil(N);
        debug_assert!(chunk_count <= u32::MAX as usize);

        // Wire layout:
        //   [discriminant?: 1B] [chunk_count: 4B] [original_len: 4B]
        //   [index: chunk_count × 8B]  ← (offset: u32, block_len: u32) per chunk
        //   [data region: lz4 blocks concatenated]
        //
        // Each lz4 block = [4B prepended original-chunk-len LE][LZ4 block data],
        // compatible with lz4_flex::block::decompress_size_prepended.
        //
        // SBF heap strategy: lz4_flex::block::compress_into allocates a new
        // HashTable4KU16 (Box<[u16; 4096]> = 8192 B) per call.  On the SBF bump
        // allocator (no free), K chunks strand K × 8192 B — for K = 23 that is
        // 188 KB, far exceeding the 32 KB heap limit.
        //
        // Fix: use lz4_compress_chunk(), our own LZ4 block compressor that takes
        // a caller-supplied &mut [u16] hash table.  Allocate the table ONCE
        // (8192 B) and clear it between chunks with fill(0) — no extra allocation.
        #[cfg(feature = "discriminant")]
        let index_base = 9usize; // 1 (discriminant) + 4 (chunk_count) + 4 (original_len)
        #[cfg(not(feature = "discriminant"))]
        let index_base = 8usize; // 4 (chunk_count) + 4 (original_len)

        let header_len = index_base + chunk_count * 8;
        let mut out = Vec::with_capacity(header_len);

        #[cfg(feature = "discriminant")]
        out.push(Self::DISCRIMINANT);

        out.extend_from_slice(&(chunk_count as u32).to_le_bytes());
        out.extend_from_slice(&(input.len() as u32).to_le_bytes());

        // Zero-fill the index; entries are patched below as each chunk is compressed.
        out.resize(header_len, 0u8);

        // One hash-table allocation for all chunks.
        let mut table = alloc::vec![0u16; LZ4_HASH_SIZE];

        let mut data_offset: u32 = 0;
        for (i, chunk) in input.chunks(N).enumerate() {
            table.fill(0); // clear between chunks — no allocation
            let block_start = out.len();
            lz4_compress_chunk(chunk, &mut table, &mut out);
            let block_len = (out.len() - block_start) as u32;

            // Patch this chunk's index entry in-place.
            let entry = index_base + i * 8;
            out[entry..entry + 4].copy_from_slice(&data_offset.to_le_bytes());
            out[entry + 4..entry + 8].copy_from_slice(&block_len.to_le_bytes());
            data_offset = data_offset.wrapping_add(block_len);
        }

        Ok(out)
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        _ = Self::CHUNK_SIZE_NONZERO;
        let data = strip_discriminant(input, Self::DISCRIMINANT)?;
        let (chunk_count, original_len) = parse_header(data)?;

        let mut out = Vec::with_capacity(original_len);
        for i in 0..chunk_count {
            let chunk = read_chunk(data, chunk_count, i)?;
            out.extend_from_slice(&chunk);
        }

        if out.len() != original_len {
            return Err(CompressionError::DecompressFailed);
        }

        Ok(out)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

#[cfg(feature = "discriminant")]
fn strip_discriminant(input: &[u8], expected: u8) -> Result<&[u8], CompressionError> {
    match input.split_first() {
        Some((&d, rest)) if d == expected => Ok(rest),
        _ => Err(CompressionError::DecompressFailed),
    }
}

// ── Minimal LZ4 block compressor ─────────────────────────────────────────────
//
// Produces output compatible with lz4_flex::block::decompress_size_prepended:
//   [4B LE: original chunk length][LZ4 block data]
//
// The LZ4 block format is a sequence of (literals + match) pairs, terminated
// by a final literals-only sequence.  Full spec:
//   https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
//
// We use a caller-supplied hash table so that ChunkedLz4::compress() can
// allocate it once and clear it between chunks (fill(0)), paying 8192 B of
// heap exactly once instead of once per chunk.

const LZ4_HASH_SIZE: usize = 4096; // must be a power of 2
const LZ4_HASH_BITS: u32 = 12; // log2(LZ4_HASH_SIZE)
const LZ4_MINMATCH: usize = 4;
const LZ4_MFLIMIT: usize = 12; // last 12 bytes of input are always literals
const LZ4_LASTLITERALS: usize = 5; // matches may not extend into the last 5 bytes

/// Compress `input` into `out` using LZ4 block format.
///
/// `table` (length == LZ4_HASH_SIZE) must be zeroed by the caller before each
/// call; it is reused across chunks to avoid repeated heap allocation on the
/// SBF bump allocator.
fn lz4_compress_chunk(input: &[u8], table: &mut [u16], out: &mut Vec<u8>) {
    debug_assert_eq!(table.len(), LZ4_HASH_SIZE);

    // Prepend original chunk length (lz4_flex's "size-prepended" wire format).
    out.extend_from_slice(&(input.len() as u32).to_le_bytes());

    let n = input.len();
    if n < LZ4_MINMATCH {
        // Input too short for any match — emit everything as a literal run.
        lz4_push_lits(out, input);
        return;
    }

    // Positions within the last LZ4_MFLIMIT bytes must not start a new match.
    let search_limit = n.saturating_sub(LZ4_MFLIMIT);
    // Matches may not extend into the last LZ4_LASTLITERALS bytes.
    let match_limit = n.saturating_sub(LZ4_LASTLITERALS);

    let mut ip = 0usize; // current position in `input`
    let mut anchor = 0usize; // start of the current literal run

    loop {
        if ip >= search_limit {
            break;
        }

        // Hash 4 bytes at `ip` and look up the hash table.
        // SAFETY: ip < search_limit = n - LZ4_MFLIMIT (12), so ip + 3 < n.
        let seq = unsafe { lz4_read4_unc(input, ip) };
        let h = lz4_hash(seq);
        let candidate = table[h] as usize;
        table[h] = ip as u16; // record current position

        // Valid match: candidate is before ip, close enough, and bytes agree.
        if candidate < ip {
            let offset = ip - candidate;
            // SAFETY for all unsafe reads below:
            //   ip < search_limit = n - LZ4_MFLIMIT (n >= 12 or early-return).
            //   So ip + 3 < n - 8, well within bounds.
            //   candidate < ip, so candidate + 3 < ip + 3 < n.
            if offset <= 0xFFFF && unsafe { lz4_read4_unc(input, candidate) } == seq {
                // Extend the match 4 bytes at a time, then byte-by-byte for the tail.
                // Avoids ~4× the loop iterations of a byte-at-a-time approach.
                let mut ml = LZ4_MINMATCH;
                // Need room for a 4-byte read at ip+ml and candidate+ml.
                let word_limit = match_limit.saturating_sub(3);
                while ip + ml < word_limit {
                    // SAFETY: ip + ml + 3 < word_limit + 3 <= match_limit <= n - LZ4_LASTLITERALS,
                    //         and match_limit <= n - 5, so ip + ml + 3 < n.
                    //         candidate + ml < ip + ml, same upper bound holds.
                    let wi = unsafe { lz4_read4_unc(input, ip + ml) };
                    let wc = unsafe { lz4_read4_unc(input, candidate + ml) };
                    if wi != wc {
                        // Find first differing byte via trailing zeros of XOR.
                        ml += (wi ^ wc).trailing_zeros() as usize / 8;
                        break;
                    }
                    ml += 4;
                }
                // Extend any remaining bytes.
                while ip + ml < match_limit && input[candidate + ml] == input[ip + ml] {
                    ml += 1;
                }

                lz4_emit_seq(out, &input[anchor..ip], offset as u16, ml);
                ip += ml;
                anchor = ip;
                continue;
            }
        }

        ip += 1;
    }

    // Emit the final literal run (no match follows).
    lz4_push_lits(out, &input[anchor..]);
}

#[inline(always)]
fn lz4_read4(data: &[u8], pos: usize) -> u32 {
    u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
}

/// Unchecked 4-byte LE read — caller must ensure `pos + 3 < data.len()`.
#[inline(always)]
unsafe fn lz4_read4_unc(data: &[u8], pos: usize) -> u32 {
    core::ptr::read_unaligned(data.as_ptr().add(pos) as *const u32)
}

#[inline(always)]
fn lz4_hash(seq: u32) -> usize {
    (seq.wrapping_mul(2654435761u32) >> (32 - LZ4_HASH_BITS)) as usize
}

/// Emit one LZ4 sequence: `lits` literal bytes followed by a back-reference.
fn lz4_emit_seq(out: &mut Vec<u8>, lits: &[u8], offset: u16, match_len: usize) {
    let ll = lits.len();
    let ml_extra = match_len - LZ4_MINMATCH;
    out.push(((ll.min(15) as u8) << 4) | (ml_extra.min(15) as u8));
    if ll >= 15 {
        lz4_push_extra(out, ll - 15);
    }
    out.extend_from_slice(lits);
    out.push(offset as u8);
    out.push((offset >> 8) as u8);
    if ml_extra >= 15 {
        lz4_push_extra(out, ml_extra - 15);
    }
}

/// Emit a final literal-only LZ4 sequence (no match offset follows).
fn lz4_push_lits(out: &mut Vec<u8>, lits: &[u8]) {
    let n = lits.len();
    out.push((n.min(15) as u8) << 4); // match nibble = 0
    if n >= 15 {
        lz4_push_extra(out, n - 15);
    }
    out.extend_from_slice(lits);
}

/// Encode a run-length extension (series of bytes summing to `remaining`).
fn lz4_push_extra(out: &mut Vec<u8>, mut remaining: usize) {
    while remaining >= 255 {
        out.push(255);
        remaining -= 255;
    }
    out.push(remaining as u8);
}

// ── Decompression helpers ─────────────────────────────────────────────────────

#[cfg(not(feature = "discriminant"))]
fn strip_discriminant(input: &[u8], _expected: u8) -> Result<&[u8], CompressionError> {
    Ok(input)
}

/// Parse the 8-byte header (after any discriminant byte has been removed).
///
/// Also validates that the full index (`chunk_count * 8` bytes after the header)
/// fits within `data`.  Returns `(chunk_count, original_len)`.
fn parse_header(data: &[u8]) -> Result<(usize, usize), CompressionError> {
    if data.len() < 8 {
        return Err(CompressionError::DecompressFailed);
    }
    let chunk_count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    let original_len = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;

    let index_bytes = chunk_count
        .checked_mul(8)
        .ok_or(CompressionError::DecompressFailed)?;
    let data_region_start = 8usize
        .checked_add(index_bytes)
        .ok_or(CompressionError::DecompressFailed)?;
    if data.len() < data_region_start {
        return Err(CompressionError::DecompressFailed);
    }

    Ok((chunk_count, original_len))
}

/// Decompress a single chunk from `data` (discriminant already stripped).
///
/// Preconditions (upheld by callers):
/// - `parse_header` has already verified the full index fits in `data`.
/// - `chunk_idx < chunk_count`.
fn read_chunk(
    data: &[u8],
    chunk_count: usize,
    chunk_idx: usize,
) -> Result<Vec<u8>, CompressionError> {
    let entry_offset = 8 + chunk_idx * 8;
    let offset =
        u32::from_le_bytes(data[entry_offset..entry_offset + 4].try_into().unwrap()) as usize;
    let compressed_len =
        u32::from_le_bytes(data[entry_offset + 4..entry_offset + 8].try_into().unwrap()) as usize;

    let data_region_start = 8 + chunk_count * 8;
    let data_region = &data[data_region_start..];

    let end = offset
        .checked_add(compressed_len)
        .ok_or(CompressionError::DecompressFailed)?;
    if end > data_region.len() {
        return Err(CompressionError::DecompressFailed);
    }

    lz4_flex::block::decompress_size_prepended(&data_region[offset..end])
        .map_err(|_| CompressionError::DecompressFailed)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompressionError, Compressor};
    use alloc::vec;
    use alloc::vec::Vec;

    type C = ChunkedLz4<4096>;
    type C512 = ChunkedLz4<512>;
    type C1024 = ChunkedLz4<1024>;

    // ── Roundtrip ─────────────────────────────────────────────────────────────

    #[test]
    fn roundtrip_empty() {
        let compressed = C::compress(b"").unwrap();
        let decompressed = C::decompress(&compressed).unwrap();
        assert_eq!(decompressed, b"");
    }

    #[test]
    fn roundtrip_single_chunk() {
        let input = b"Hello Solana!";
        let compressed = C::compress(input).unwrap();
        let decompressed = C::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn roundtrip_exact_boundary() {
        // Exactly 4096 bytes — one full chunk, nothing partial.
        let input: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        let compressed = C::compress(&input).unwrap();
        let decompressed = C::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn roundtrip_multi_chunk() {
        // 10 000 bytes → 3 chunks (4096 + 4096 + 1808).
        let input: Vec<u8> = (0u8..=255).cycle().take(10_000).collect();
        let compressed = C::compress(&input).unwrap();
        let decompressed = C::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn roundtrip_repetitive() {
        let input: Vec<u8> = b"aaaa".repeat(2048); // 8192 bytes → 2 chunks
        let compressed = C::compress(&input).unwrap();
        assert!(
            compressed.len() < input.len(),
            "repetitive data should compress"
        );
        let decompressed = C::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    // ── chunk_count ───────────────────────────────────────────────────────────

    #[test]
    fn chunk_count_empty() {
        let compressed = C::compress(b"").unwrap();
        assert_eq!(C::chunk_count(&compressed).unwrap(), 0);
    }

    #[test]
    fn chunk_count_single() {
        let compressed = C::compress(b"hello").unwrap();
        assert_eq!(C::chunk_count(&compressed).unwrap(), 1);
    }

    #[test]
    fn chunk_count_multi() {
        let input = vec![0u8; 10_000];
        let compressed = C::compress(&input).unwrap();
        // 10 000 / 4096 = 2 full + 1 partial = 3 chunks
        assert_eq!(C::chunk_count(&compressed).unwrap(), 3);
    }

    #[test]
    fn chunk_count_exact_boundary() {
        let input = vec![0u8; 4096];
        let compressed = C::compress(&input).unwrap();
        assert_eq!(C::chunk_count(&compressed).unwrap(), 1);
    }

    // ── decompress_chunk ──────────────────────────────────────────────────────

    #[test]
    fn decompress_chunk_single() {
        let input = b"Hello!";
        let compressed = C::compress(input).unwrap();
        let chunk = C::decompress_chunk(&compressed, 0).unwrap();
        assert_eq!(chunk, input);
    }

    #[test]
    fn decompress_chunk_all_multi() {
        // Decompress chunk-by-chunk and reassemble; must equal original.
        let input: Vec<u8> = (0u8..=255).cycle().take(9_000).collect();
        let compressed = C::compress(&input).unwrap();
        let count = C::chunk_count(&compressed).unwrap();
        let mut reconstructed = Vec::new();
        for i in 0..count {
            let chunk = C::decompress_chunk(&compressed, i).unwrap();
            reconstructed.extend_from_slice(&chunk);
        }
        assert_eq!(reconstructed, input);
    }

    #[test]
    fn decompress_chunk_last_partial() {
        // 4097 bytes: chunk 0 = 4096 bytes, chunk 1 = 1 byte.
        let input = vec![42u8; 4097];
        let compressed = C::compress(&input).unwrap();
        let last = C::decompress_chunk(&compressed, 1).unwrap();
        assert_eq!(last, vec![42u8]);
    }

    #[test]
    fn decompress_chunk_out_of_bounds() {
        let input = b"hello";
        let compressed = C::compress(input).unwrap();
        // Only chunk 0 exists; chunk 1 must fail.
        let result = C::decompress_chunk(&compressed, 1);
        assert_eq!(result, Err(CompressionError::DecompressFailed));
    }

    // ── Error cases ───────────────────────────────────────────────────────────

    #[test]
    fn header_too_short() {
        // With discriminant: 1 disc byte + 4 bytes = 5 total; strip disc → 4 < 8.
        // Without discriminant: 4 bytes < 8.
        // Using [0x02, ...] works in both paths.
        #[cfg(feature = "discriminant")]
        let data: &[u8] = &[0x02, 0x01, 0x00, 0x00, 0x00];
        #[cfg(not(feature = "discriminant"))]
        let data: &[u8] = &[0x01, 0x00, 0x00, 0x00];
        assert_eq!(C::decompress(data), Err(CompressionError::DecompressFailed));
    }

    #[test]
    fn corrupt_chunk_bytes() {
        // Compress exactly one chunk of repetitive data, then zero the data
        // region so the lz4 prepended-size reads as 0.  The decompressed
        // length (0) won't match original_len (4096) → DecompressFailed.
        let input = vec![42u8; 4096];
        let mut compressed = C::compress(&input).unwrap();
        // data region start: [disc?:1] + header:8 + index(1 entry):8
        #[cfg(feature = "discriminant")]
        let dr_start = 17; // 1 + 8 + 8
        #[cfg(not(feature = "discriminant"))]
        let dr_start = 16; // 8 + 8
        for b in compressed[dr_start..].iter_mut() {
            *b = 0;
        }
        assert_eq!(
            C::decompress(&compressed),
            Err(CompressionError::DecompressFailed)
        );
    }

    #[test]
    fn compressed_len_overflow() {
        // Manually build a buffer: chunk_count=1, original_len=5,
        // index entry: offset=0, compressed_len=u32::MAX.
        // The data region is empty, so the bounds check catches the overflow.
        let mut data: Vec<u8> = Vec::new();
        #[cfg(feature = "discriminant")]
        data.push(0x02); // ChunkedLz4::DISCRIMINANT
        data.extend_from_slice(&1u32.to_le_bytes()); // chunk_count = 1
        data.extend_from_slice(&5u32.to_le_bytes()); // original_len = 5
        data.extend_from_slice(&0u32.to_le_bytes()); // offset = 0
        data.extend_from_slice(&u32::MAX.to_le_bytes()); // compressed_len = u32::MAX
                                                         // data region is empty: 0 + u32::MAX > 0 → DecompressFailed
        assert_eq!(
            C::decompress(&data),
            Err(CompressionError::DecompressFailed)
        );
    }

    #[test]
    #[cfg(feature = "discriminant")]
    fn wrong_discriminant() {
        let mut compressed = C::compress(b"hello").unwrap();
        compressed[0] = 0xFF; // corrupt the discriminant byte
        assert_eq!(
            C::decompress(&compressed),
            Err(CompressionError::DecompressFailed)
        );
    }

    // ── Regression ────────────────────────────────────────────────────────────

    #[test]
    fn discriminants_differ() {
        assert_ne!(crate::Lz4::DISCRIMINANT, C::DISCRIMINANT);
        assert_eq!(crate::Lz4::DISCRIMINANT, 0x01);
        assert_eq!(C::DISCRIMINANT, 0x02);
    }

    #[test]
    fn lz4_output_rejected_by_chunked() {
        // Lz4 output must not be accepted by ChunkedLz4::decompress.
        // With discriminant: first byte is 0x01 ≠ 0x02 → immediate failure.
        // Without discriminant: Lz4 raw block parsed as chunk_count leads to
        //   index size > total data length → parse_header returns DecompressFailed.
        let lz4_compressed = crate::Lz4::compress(b"hello").unwrap();
        assert_eq!(
            C::decompress(&lz4_compressed),
            Err(CompressionError::DecompressFailed)
        );
    }

    // ── Const-generic variants ────────────────────────────────────────────────

    #[test]
    fn roundtrip_chunk_512() {
        let input: Vec<u8> = (0u8..=255).cycle().take(2_000).collect();
        let compressed = C512::compress(&input).unwrap();
        let decompressed = C512::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn roundtrip_chunk_1024() {
        let input: Vec<u8> = (0u8..=255).cycle().take(3_000).collect();
        let compressed = C1024::compress(&input).unwrap();
        let decompressed = C1024::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }
}
