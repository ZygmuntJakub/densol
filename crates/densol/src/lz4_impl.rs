use crate::{Compressor, CompressionError};
use alloc::vec::Vec;

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
            return Ok(out);
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
