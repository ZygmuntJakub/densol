use crate::{Compressor, CompressionError};
use alloc::vec::Vec;

/// DEFLATE compression strategy via miniz_oxide.
///
/// # SBF heap constraint
///
/// `compress()` allocates ~128 KB for the DEFLATE hash table on the heap and is
/// **not suitable for on-chain use** on the Solana SBF runtime (32 KB default heap).
/// Use it off-chain (client side) and upload the compressed bytes directly.
///
/// `decompress()` only needs the output buffer (~N bytes) and works on-chain for
/// original data sizes up to ~32 KB.
///
/// # Wire format
///
/// When the `discriminant` feature is enabled, the payload is prefixed with `0x02`:
/// ```text
/// ┌────────────────┬─────────────────────────┐
/// │ 0x02 (Deflate) │  raw DEFLATE payload     │
/// └────────────────┴─────────────────────────┘
/// ```
/// The raw DEFLATE format (RFC 1951) is used — no zlib or gzip framing.
/// In Node.js, compress with `zlib.deflateRawSync(buf, { level: 6 })`.
pub struct Deflate;

impl Compressor for Deflate {
    const NAME: &'static str = "deflate";
    const DISCRIMINANT: u8 = 0x02;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        let inner = miniz_oxide::deflate::compress_to_vec(input, 6);

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

        miniz_oxide::inflate::decompress_to_vec(input)
            .map_err(|_| CompressionError::DecompressFailed)
    }
}
