use anchor_lang::prelude::*;
use densol::Compressor;
use densol_derive::Compress;

declare_id!("AwLfrSLLSDht8b59VmyVhLGSg5vgdKyWMseKQpjSohKM");

// ── Strategy selection ────────────────────────────────────────────────────────

#[cfg(all(feature = "lz4",     feature = "identity"))] compile_error!("select exactly one strategy: not both lz4 + identity");
#[cfg(all(feature = "lz4",     feature = "deflate"))]  compile_error!("select exactly one strategy: not both lz4 + deflate");
#[cfg(all(feature = "lz4",     feature = "rle"))]      compile_error!("select exactly one strategy: not both lz4 + rle");
#[cfg(all(feature = "identity",feature = "deflate"))]  compile_error!("select exactly one strategy: not both identity + deflate");
#[cfg(all(feature = "identity",feature = "rle"))]      compile_error!("select exactly one strategy: not both identity + rle");
#[cfg(all(feature = "deflate", feature = "rle"))]      compile_error!("select exactly one strategy: not both deflate + rle");

#[cfg(not(any(feature = "lz4", feature = "identity", feature = "deflate", feature = "rle")))]
compile_error!("select exactly one strategy feature: lz4 | identity | deflate | rle");

#[cfg(feature = "lz4")]
use densol::Lz4 as Strategy;

#[cfg(feature = "identity")]
use densol::Identity as Strategy;

#[cfg(feature = "deflate")]
use densol::Deflate as Strategy;

#[cfg(feature = "rle")]
use densol::Rle as Strategy;

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod compress_bench {
    use super::*;

    pub fn init_store(_ctx: Context<InitStore>) -> Result<()> {
        Ok(())
    }

    /// Upload raw bytes in chunks (Solana tx limit ~1.2 KB).
    pub fn append_chunk(ctx: Context<AppendChunk>, chunk: Vec<u8>) -> Result<()> {
        ctx.accounts.store.data.extend_from_slice(&chunk);
        Ok(())
    }

    /// On-chain compress: compresses store.data in place, resizes account.
    ///
    /// This is the realistic "write with compression" path:
    ///   1. Read raw bytes from account (Borsh deser)
    ///   2. Compress on-chain via Strategy::compress (set_data)
    ///   3. Realloc account to compressed size (may grow for incompressible data)
    ///
    /// Expects store.data to contain RAW (uncompressed) bytes.
    pub fn compress_stored(ctx: Context<CompressStored>) -> Result<()> {
        // Move data out instead of cloning to stay within the 32KB SBF heap.
        // std::mem::take replaces self.data with an empty Vec (zero allocation).
        // lz4_flex's hash table is stack-allocated, so heap peak = raw_bytes + compressed_output.
        // For 10KB random input: ~10KB + ~10KB = ~20KB < 32KB heap limit.
        let raw = std::mem::take(&mut ctx.accounts.store.data);
        let raw_len = raw.len();

        ctx.accounts.store
            .set_data(&raw)
            .map_err(|_| error!(BenchError::CompressFailed))?;
        drop(raw); // free original bytes immediately after compression

        // New account size: [8 disc][4 Borsh vec prefix][compressed bytes]
        let new_len = 8 + 4 + ctx.accounts.store.data.len();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = ctx.accounts.store.to_account_info().lamports();

        // If compressed output is larger than raw (incompressible data),
        // top up lamports from payer before growing the account.
        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.store.to_account_info(),
                    },
                ),
                needed - current,
            )?;
        }

        ctx.accounts.store
            .to_account_info()
            .realloc(new_len, false)?;

        msg!(
            "compress_stored strategy={} raw={}B compressed={}B ratio={:.2}x",
            Strategy::NAME,
            raw_len,
            ctx.accounts.store.data.len(),
            raw_len as f64 / ctx.accounts.store.data.len() as f64,
        );
        Ok(())
    }

    /// Borsh baseline: deser only, no compute on bytes.
    /// Subtract from other benchmarks to isolate algorithm cost.
    pub fn benchmark_borsh(ctx: Context<Benchmark>) -> Result<()> {
        msg!("borsh_ok strategy={} bytes={}", Strategy::NAME, ctx.accounts.store.data.len());
        Ok(())
    }

    /// Raw read path: Borsh deser(N) + O(N) checksum.
    /// Expects store.data to contain RAW (uncompressed) bytes.
    pub fn benchmark_raw(ctx: Context<Benchmark>) -> Result<()> {
        let data = &ctx.accounts.store.data;
        let checksum: u64 = data.iter().map(|&b| b as u64).sum();
        msg!("raw_ok bytes={} checksum={}", data.len(), checksum);
        Ok(())
    }

    /// Compressed read path: Borsh deser(M) + decompress(M→N) + checksum(N).
    /// Expects store.data to contain COMPRESSED bytes (written by compress_stored).
    pub fn benchmark_decompress(ctx: Context<Benchmark>) -> Result<()> {
        let decompressed = ctx.accounts.store
            .get_data()
            .map_err(|_| error!(BenchError::DecompressFailed))?;
        let checksum: u64 = decompressed.iter().map(|&b| b as u64).sum();
        msg!(
            "decompress_ok strategy={} compressed={}B original={}B checksum={}",
            Strategy::NAME,
            ctx.accounts.store.data.len(),
            decompressed.len(),
            checksum,
        );
        Ok(())
    }
}

// ── Accounts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitStore<'info> {
    #[account(init, payer = payer, space = 8 + 4)]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk: Vec<u8>)]
pub struct AppendChunk<'info> {
    #[account(
        mut,
        realloc = 8 + 4 + store.data.len() + chunk.len(),
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompressStored<'info> {
    #[account(mut)]
    pub store: Account<'info, DataStore>,
    /// Funds lamport top-up when compressed output is larger than raw input
    /// (only for incompressible data where compression ratio < 1).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Benchmark<'info> {
    pub store: Account<'info, DataStore>,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
#[derive(Compress)]
pub struct DataStore {
    #[compress]
    pub data: Vec<u8>,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum BenchError {
    #[msg("compression failed")]
    CompressFailed,
    #[msg("decompression failed (corrupt or wrong format)")]
    DecompressFailed,
}
