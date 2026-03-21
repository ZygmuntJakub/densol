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

        // Compress each chunk independently (off-chain, heap is not a concern).
        let compressed_chunks: Vec<Vec<u8>> = input
            .chunks(N)
            .map(lz4_flex::block::compress_prepend_size)
            .collect();

        let data_len: usize = compressed_chunks.iter().map(|c| c.len()).sum();

        // discriminant(0|1) + header(8) + index(chunk_count * 8) + data_region
        #[cfg(feature = "discriminant")]
        let capacity = 1 + 8 + chunk_count * 8 + data_len;
        #[cfg(not(feature = "discriminant"))]
        let capacity = 8 + chunk_count * 8 + data_len;

        let mut out = Vec::with_capacity(capacity);

        #[cfg(feature = "discriminant")]
        out.push(Self::DISCRIMINANT);

        // Header
        out.extend_from_slice(&(chunk_count as u32).to_le_bytes());
        out.extend_from_slice(&(input.len() as u32).to_le_bytes());

        // Index: (offset, compressed_len) per chunk; offsets relative to data region.
        let mut offset: u32 = 0;
        for chunk in &compressed_chunks {
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            offset = offset.wrapping_add(chunk.len() as u32);
        }

        // Data region: concatenated lz4 blocks.
        for chunk in &compressed_chunks {
            out.extend_from_slice(chunk);
        }

        Ok(out)
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        _ = Self::CHUNK_SIZE_NONZERO;
        let data = strip_discriminant(input, Self::DISCRIMINANT)?;
        let (chunk_count, original_len) = parse_header(data)?;

        let mut out = Vec::new();
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
