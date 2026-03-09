#![no_std]
extern crate alloc;

use alloc::vec::Vec;
use core::fmt;

/// Stateless compression strategy.
///
/// Methods are free functions (no `self`) — algorithms carry no runtime state on SBF
/// and monomorphisation avoids vtable overhead.  The trait is not object-safe by design.
///
/// Select a strategy at compile time via feature flags, then alias it:
/// ```ignore
/// use solana_compression::Lz4 as Strategy;
/// ```
pub trait Compressor {
    /// Short identifier used in program logs and metrics.
    const NAME: &'static str;

    /// Single-byte wire tag.  Always required; written/validated only when the
    /// `discriminant` feature is active.
    const DISCRIMINANT: u8;

    /// Compress `input`.  Returns `Err` only on hard algorithm limits (e.g. max
    /// input size).  LZ4 is infallible and always returns `Ok`.
    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError>;

    /// Decompress `input` previously produced by [`compress`].
    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError>;
}

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionError {
    /// Input is corrupt, truncated, or was produced by a different algorithm.
    DecompressFailed,
    /// Input exceeds the algorithm's maximum supported size.
    /// Note: lz4_flex::compress_prepend_size is infallible; this variant is
    /// reserved for future algorithms (e.g. zstd) that enforce size limits.
    InputTooLarge,
}

impl fmt::Display for CompressionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DecompressFailed => f.write_str("decompression failed: corrupt or wrong format"),
            Self::InputTooLarge    => f.write_str("input exceeds maximum supported size"),
        }
    }
}

#[cfg(feature = "std")]
extern crate std;

#[cfg(feature = "std")]
impl std::error::Error for CompressionError {}

// ── Implementations ───────────────────────────────────────────────────────────

#[cfg(feature = "lz4")]
mod lz4_impl;
#[cfg(feature = "lz4")]
pub use lz4_impl::Lz4;

#[cfg(feature = "identity")]
mod identity;
#[cfg(feature = "identity")]
pub use identity::Identity;

#[cfg(feature = "deflate")]
mod deflate_impl;
#[cfg(feature = "deflate")]
pub use deflate_impl::Deflate;

#[cfg(feature = "rle")]
mod rle_impl;
#[cfg(feature = "rle")]
pub use rle_impl::Rle;
