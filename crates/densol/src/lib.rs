//! On-chain LZ4 compression for Solana programs.
//!
//! `densol` provides a [`Compressor`] trait and a ready-to-use [`Lz4`] implementation
//! that fits within the SBF VM's 32 KB heap constraint. Pair it with
//! [`densol-derive`](https://crates.io/crates/densol-derive) to add transparent
//! compression to any Anchor account field with a single attribute.
//!
//! # Quick start
//!
//! Add to `Cargo.toml`:
//! ```toml
//! densol = "0.1"
//! ```
//!
//! ```ignore
//! use densol::Lz4 as Strategy;
//! use densol::Compress;
//!
//! #[account]
//! #[derive(Compress)]
//! pub struct MyAccount {
//!     #[compress]
//!     pub data: Vec<u8>,
//! }
//!
//! // generated:
//! // my_account.set_data(&raw_bytes)?;  // compress + store
//! // let raw = my_account.get_data()?;  // load + decompress
//! ```
//!
//! # Features
//!
//! | Feature | Default | Description |
//! |---|---|---|
//! | `lz4` | yes | Enables the [`Lz4`] strategy via `lz4_flex` |
//! | `discriminant` | yes | Prepends a 1-byte algorithm tag to compressed output |
//! | `derive` | yes | Re-exports the `#[derive(Compress)]` macro |
//! | `std` | no | Implements `std::error::Error` for [`CompressionError`] |

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
/// use densol::Lz4 as Strategy;
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

    /// Decompress `input` previously produced by [`Self::compress`].
    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError>;
}

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
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
            Self::InputTooLarge => f.write_str("input exceeds maximum supported size"),
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

#[cfg(feature = "chunked_lz4")]
mod chunked_lz4_impl;
#[cfg(feature = "chunked_lz4")]
pub use chunked_lz4_impl::{ChunkedLz4, lz4_compress_chunk, LZ4_HASH_TABLE_WORDS};

#[cfg(feature = "lz4_huffman")]
mod lz4_huffman_impl;
#[cfg(feature = "lz4_huffman")]
pub use lz4_huffman_impl::Lz4Huffman;

// ── Derive re-export ──────────────────────────────────────────────────────────

#[cfg(feature = "derive")]
pub use densol_derive::Compress;
