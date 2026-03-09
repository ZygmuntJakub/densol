use crate::{Compressor, CompressionError};
use alloc::vec::Vec;

/// Run-Length Encoding — O(1) memory, zero allocations during compression beyond output buffer.
///
/// Serves as a lower bound baseline: any algorithm that can't beat RLE on a given dataset
/// doesn't justify its added complexity.
///
/// # Wire format
///
/// 4-byte little-endian original length header (for decompression), then a stream of packets:
///
/// ```text
/// packet = RUN | LITERAL
/// RUN     = 0x80 | (count - 1)  then 1 byte   (1–128 repetitions of that byte)
/// LITERAL = (count - 1)         then count bytes (1–128 raw bytes)
/// ```
///
/// Run packets are emitted for 3+ consecutive identical bytes.
/// Everything else is packed into literal packets.
/// Worst-case output size: original + ceil(N/128) + 4 bytes (one header per 128-byte literal packet).
pub struct Rle;

impl Compressor for Rle {
    const NAME: &'static str = "rle";
    const DISCRIMINANT: u8 = 0x03;

    fn compress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        // Worst case: every byte packed into 128-byte literal packets → 1 header per 128 bytes.
        // +1 for discriminant byte (always reserve it even when feature is off, costs nothing).
        let worst = 1 + 4 + input.len() + input.len().div_ceil(128);
        let mut out = Vec::with_capacity(worst);

        #[cfg(feature = "discriminant")]
        out.push(Self::DISCRIMINANT);

        out.extend_from_slice(&(input.len() as u32).to_le_bytes());

        let mut i = 0;
        while i < input.len() {
            let b = input[i];
            // Count how many consecutive identical bytes follow (up to 128).
            let run_end = (i + 128).min(input.len());
            let run_len = input[i..run_end].iter().take_while(|&&x| x == b).count();

            if run_len >= 3 {
                // RUN packet: 1 header byte + 1 data byte.
                out.push(0x80 | (run_len as u8 - 1));
                out.push(b);
                i += run_len;
            } else {
                // LITERAL packet: scan ahead until we hit a worthwhile run or the limit.
                let lit_start = i;
                i += 1; // consume at least one byte
                while i < input.len() && (i - lit_start) < 128 {
                    // Peek ahead: if ≥3 identical bytes start here, break and let the run handle them.
                    let peek_end = (i + 3).min(input.len());
                    let next_run = input[i..peek_end].iter().take_while(|&&x| x == input[i]).count();
                    if next_run >= 3 {
                        break;
                    }
                    i += 1;
                }
                let lit_len = i - lit_start;
                out.push(lit_len as u8 - 1);
                out.extend_from_slice(&input[lit_start..i]);
            }
        }

        Ok(out)
    }

    fn decompress(input: &[u8]) -> Result<Vec<u8>, CompressionError> {
        #[cfg(feature = "discriminant")]
        let input = match input.split_first() {
            Some((&d, rest)) if d == Self::DISCRIMINANT => rest,
            _ => return Err(CompressionError::DecompressFailed),
        };

        if input.len() < 4 {
            return Err(CompressionError::DecompressFailed);
        }
        let orig_len = u32::from_le_bytes(
            input[..4].try_into().map_err(|_| CompressionError::DecompressFailed)?
        ) as usize;

        let mut out = Vec::with_capacity(orig_len);
        let mut i = 4;

        while i < input.len() {
            let header = input[i];
            i += 1;
            if header & 0x80 != 0 {
                // RUN packet.
                let count = (header & 0x7F) as usize + 1;
                if i >= input.len() {
                    return Err(CompressionError::DecompressFailed);
                }
                let byte = input[i];
                i += 1;
                out.extend(core::iter::repeat(byte).take(count));
            } else {
                // LITERAL packet.
                let count = header as usize + 1;
                if i + count > input.len() {
                    return Err(CompressionError::DecompressFailed);
                }
                out.extend_from_slice(&input[i..i + count]);
                i += count;
            }
        }

        if out.len() != orig_len {
            return Err(CompressionError::DecompressFailed);
        }
        Ok(out)
    }
}
