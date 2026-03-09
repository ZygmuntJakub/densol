use crate::{Compressor, CompressionError};
use alloc::vec::Vec;

/// Pass-through strategy: compress = clone, decompress = clone.
///
/// Zero algorithm cost — useful as a CU baseline for benchmarks to measure
/// account overhead (Borsh + realloc) in isolation.
pub struct Identity;

impl Compressor for Identity {
    const NAME: &'static str = "identity";
    const DISCRIMINANT: u8 = 0x00;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        #[cfg(feature = "discriminant")]
        {
            let mut out = Vec::with_capacity(1 + input.len());
            out.push(Self::DISCRIMINANT);
            out.extend_from_slice(input);
            return Ok(out);
        }

        #[cfg(not(feature = "discriminant"))]
        Ok(input.to_vec())
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        #[cfg(feature = "discriminant")]
        let input = match input.split_first() {
            Some((&d, rest)) if d == Self::DISCRIMINANT => rest,
            _ => return Err(CompressionError::DecompressFailed),
        };

        Ok(input.to_vec())
    }
}
