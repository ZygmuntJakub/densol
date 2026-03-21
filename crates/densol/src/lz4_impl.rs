use crate::{CompressionError, Compressor};
use alloc::vec::Vec;

/// LZ4 compression strategy.
///
/// Uses [`lz4_flex`] block format with a prepended original-size header.
/// The hash table (`[u32; 4096]` = 16 KB) is stack-allocated, keeping
/// heap usage to two allocations: the moved input and the output buffer
/// (`N + N/100 + 27` bytes).
///
/// When the `discriminant` feature is active, a single tag byte (`0x01`)
/// is prepended to the compressed output so the format can be detected at
/// read time.
pub struct Lz4;

impl Compressor for Lz4 {
    const NAME: &'static str = "lz4";
    const DISCRIMINANT: u8 = 0x01;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        let inner = lz4_flex::block::compress_prepend_size(input);

        #[cfg(feature = "discriminant")]
        {
            let mut out = Vec::with_capacity(1 + inner.len());
            out.push(Self::DISCRIMINANT);
            out.extend_from_slice(&inner);
            Ok(out)
        }

        #[cfg(not(feature = "discriminant"))]
        Ok(inner)
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        #[cfg(feature = "discriminant")]
        let input = match input.split_first() {
            Some((&d, rest)) if d == Self::DISCRIMINANT => rest,
            _ => return Err(CompressionError::DecompressFailed),
        };

        lz4_flex::block::decompress_size_prepended(input)
            .map_err(|_| CompressionError::DecompressFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_basic() {
        let input = b"Hello Solana! This is a test of on-chain LZ4 compression.";
        let compressed = Lz4::compress(input).unwrap();
        let decompressed = Lz4::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn roundtrip_empty() {
        let compressed = Lz4::compress(b"").unwrap();
        let decompressed = Lz4::decompress(&compressed).unwrap();
        assert_eq!(decompressed, b"");
    }

    #[test]
    fn roundtrip_repetitive() {
        let input: Vec<u8> = b"aaaa".repeat(256);
        let compressed = Lz4::compress(&input).unwrap();
        assert!(
            compressed.len() < input.len(),
            "repetitive data should compress"
        );
        let decompressed = Lz4::decompress(&compressed).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn corrupt_input_returns_error() {
        let result = Lz4::decompress(b"this is not valid lz4 data");
        assert_eq!(result, Err(CompressionError::DecompressFailed));
    }

    #[test]
    #[cfg(feature = "discriminant")]
    fn wrong_discriminant_returns_error() {
        let mut compressed = Lz4::compress(b"hello").unwrap();
        compressed[0] = 0xFF; // corrupt the discriminant byte
        let result = Lz4::decompress(&compressed);
        assert_eq!(result, Err(CompressionError::DecompressFailed));
    }
}
