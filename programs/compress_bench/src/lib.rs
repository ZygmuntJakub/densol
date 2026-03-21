use anchor_lang::prelude::*;
#[cfg(feature = "chunked_lz4")]
use densol::ChunkedLz4;
use densol::{Compress, Compressor};

declare_id!("AwLfrSLLSDht8b59VmyVhLGSg5vgdKyWMseKQpjSohKM");

use densol::Lz4 as Strategy;

#[program]
pub mod compress_bench {
    use super::*;

    pub fn init_store(_ctx: Context<InitStore>) -> Result<()> {
        Ok(())
    }

    /// Receive raw bytes and store them in the account.
    /// Used as both the write benchmark baseline and the upload helper
    /// for setting up large accounts for read benchmarks.
    pub fn store_raw(ctx: Context<StoreRaw>, data: Vec<u8>) -> Result<()> {
        let store = &mut ctx.accounts.store;
        store.data.extend_from_slice(&data);

        let new_len = 8 + 4 + store.data.len();
        let info = store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();

        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }

        info.resize(new_len)?;

        msg!("store_raw bytes={}", store.data.len());
        Ok(())
    }

    /// Receive raw bytes, compress via LZ4, and store compressed in the account.
    /// Write benchmark — compare CU against store_raw for the same data.
    pub fn store_compressed(ctx: Context<StoreCompressed>, data: Vec<u8>) -> Result<()> {
        let store = &mut ctx.accounts.store;
        store
            .set_data(&data)
            .map_err(|_| error!(BenchError::CompressFailed))?;

        let new_len = 8 + 4 + store.data.len();
        let info = store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();

        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }

        info.resize(new_len)?;

        msg!(
            "store_compressed raw={}B compressed={}B ratio={:.2}x",
            data.len(),
            store.data.len(),
            data.len() as f64 / store.data.len() as f64,
        );
        Ok(())
    }

    /// Compress existing raw data in the account in-place.
    /// Used to set up compressed accounts for read benchmarks at sizes
    /// that exceed the transaction limit.
    pub fn compress_stored(ctx: Context<CompressStored>) -> Result<()> {
        let raw = std::mem::take(&mut ctx.accounts.store.data);
        let raw_len = raw.len();

        ctx.accounts
            .store
            .set_data(&raw)
            .map_err(|_| error!(BenchError::CompressFailed))?;
        drop(raw);

        let new_len = 8 + 4 + ctx.accounts.store.data.len();
        let info = ctx.accounts.store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();

        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }

        info.resize(new_len)?;

        msg!(
            "compress_stored raw={}B compressed={}B ratio={:.2}x",
            raw_len,
            ctx.accounts.store.data.len(),
            raw_len as f64 / ctx.accounts.store.data.len() as f64,
        );
        Ok(())
    }

    /// Read raw account data and compute O(N) checksum.
    pub fn read_raw(ctx: Context<ReadStore>) -> Result<()> {
        let data = &ctx.accounts.store.data;
        let checksum: u64 = data.iter().map(|&b| b as u64).sum();
        msg!("read_raw bytes={} checksum={}", data.len(), checksum);
        Ok(())
    }

    /// Read compressed account data, decompress, and compute O(N) checksum.
    pub fn read_compressed(ctx: Context<ReadStore>) -> Result<()> {
        let decompressed = ctx
            .accounts
            .store
            .get_data()
            .map_err(|_| error!(BenchError::DecompressFailed))?;
        let checksum: u64 = decompressed.iter().map(|&b| b as u64).sum();
        msg!(
            "read_compressed compressed={}B original={}B checksum={}",
            ctx.accounts.store.data.len(),
            decompressed.len(),
            checksum,
        );
        Ok(())
    }

    /// Receive raw bytes, compress via ChunkedLz4<4096>, and store compressed in the account.
    /// Write benchmark — compare CU against store_raw for the same data.
    #[cfg(feature = "chunked_lz4")]
    pub fn store_chunked(ctx: Context<StoreChunked>, data: Vec<u8>) -> Result<()> {
        let raw_len = data.len();
        let compressed =
            ChunkedLz4::<4096>::compress(&data).map_err(|_| error!(BenchError::CompressFailed))?;
        let comp_len = compressed.len();
        let store = &mut ctx.accounts.store;
        store.data = compressed;

        let new_len = 8 + 4 + store.data.len();
        let info = store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();

        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }

        info.resize(new_len)?;

        msg!(
            "store_chunked raw={} compressed={} ratio={:.2}x",
            raw_len,
            comp_len,
            raw_len as f64 / comp_len as f64,
        );
        Ok(())
    }

    /// Compress existing raw data in the account in-place using ChunkedLz4<4096>.
    /// Used to set up compressed accounts for read benchmarks at sizes
    /// that exceed the transaction limit.
    #[cfg(feature = "chunked_lz4")]
    pub fn compress_stored_chunked(ctx: Context<CompressStored>) -> Result<()> {
        let raw = std::mem::take(&mut ctx.accounts.store.data);
        let raw_len = raw.len();

        let compressed =
            ChunkedLz4::<4096>::compress(&raw).map_err(|_| error!(BenchError::CompressFailed))?;
        drop(raw);
        let comp_len = compressed.len();

        ctx.accounts.store.data = compressed;

        let new_len = 8 + 4 + ctx.accounts.store.data.len();
        let info = ctx.accounts.store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();

        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }

        info.resize(new_len)?;

        msg!(
            "compress_stored_chunked raw={} compressed={} ratio={:.2}x",
            raw_len,
            comp_len,
            raw_len as f64 / comp_len as f64,
        );
        Ok(())
    }

    /// Read ChunkedLz4-compressed account data, decompress fully, and compute O(N) checksum.
    #[cfg(feature = "chunked_lz4")]
    pub fn read_chunked_full(ctx: Context<ReadStore>) -> Result<()> {
        let decompressed = ChunkedLz4::<4096>::decompress(&ctx.accounts.store.data)
            .map_err(|_| error!(BenchError::DecompressFailed))?;
        let checksum: u64 = decompressed.iter().map(|&b| b as u64).sum();
        msg!(
            "read_chunked_full compressed={} original={} checksum={}",
            ctx.accounts.store.data.len(),
            decompressed.len(),
            checksum,
        );
        Ok(())
    }

    /// Decompress a single 4 KB chunk from a ChunkedLz4-compressed account.
    /// O(chunk_size) heap — no OOM ceiling regardless of total account size.
    #[cfg(feature = "chunked_lz4")]
    pub fn read_chunked_chunk(ctx: Context<ReadStore>, chunk_idx: u32) -> Result<()> {
        let chunk =
            ChunkedLz4::<4096>::decompress_chunk(&ctx.accounts.store.data, chunk_idx as usize)
                .map_err(|_| error!(BenchError::DecompressFailed))?;
        let checksum: u64 = chunk.iter().map(|&b| b as u64).sum();
        msg!(
            "read_chunked_chunk idx={} chunk_bytes={} checksum={}",
            chunk_idx,
            chunk.len(),
            checksum,
        );
        Ok(())
    }

    /// Append raw bytes to a large account using zero-copy AccountInfo access.
    /// Unlike storeRaw, this does NOT deserialize the full Vec<u8> — the existing
    /// account bytes are never heap-allocated. Peak heap: only the data parameter (~800 B).
    #[cfg(feature = "chunked_lz4")]
    pub fn append_raw_large(ctx: Context<AppendRawLarge>, data: Vec<u8>) -> Result<()> {
        let current_data_len: usize;
        {
            let acc = ctx.accounts.store.data.borrow();
            require!(acc.len() >= 12, BenchError::CompressFailed);
            current_data_len = u32::from_le_bytes(acc[8..12].try_into().unwrap()) as usize;
        }

        let new_data_len = current_data_len + data.len();
        let new_account_len = 8 + 4 + new_data_len;

        let info = ctx.accounts.store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_account_len);
        let current = info.lamports();
        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }
        info.resize(new_account_len)?;

        {
            let mut acc = ctx.accounts.store.data.borrow_mut();
            acc[8..12].copy_from_slice(&(new_data_len as u32).to_le_bytes());
            let start = 12 + current_data_len;
            acc[start..start + data.len()].copy_from_slice(&data);
        }

        msg!("append_raw_large total_bytes={}", new_data_len);
        Ok(())
    }

    /// Compress a large raw account in-place using ChunkedLz4<4096>.
    /// Uses AccountInfo to bypass Anchor deserialization — the raw 90 KB
    /// never lands on the heap. Peak heap: ~3 KB (compressed chunks + output).
    #[cfg(feature = "chunked_lz4")]
    pub fn compress_stored_chunked_large(ctx: Context<CompressStoredLarge>) -> Result<()> {
        let raw_len: usize;
        let compressed: Vec<u8>;
        {
            let data = ctx.accounts.store.data.borrow();
            // Layout: [8B discriminator][4B Vec length LE][N bytes raw data]
            require!(data.len() >= 12, BenchError::CompressFailed);
            let raw = &data[12..];
            raw_len = raw.len();
            compressed = ChunkedLz4::<4096>::compress(raw)
                .map_err(|_| error!(BenchError::CompressFailed))?;
        } // borrow released

        let comp_len = compressed.len();
        let new_len = 8 + 4 + comp_len;

        let info = ctx.accounts.store.to_account_info();
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len);
        let current = info.lamports();
        if needed > current {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                needed - current,
            )?;
        }
        info.resize(new_len)?;

        {
            let mut data = ctx.accounts.store.data.borrow_mut();
            // discriminator (bytes 0..8) is preserved — do not overwrite
            data[8..12].copy_from_slice(&(comp_len as u32).to_le_bytes());
            data[12..12 + comp_len].copy_from_slice(&compressed);
        }

        msg!(
            "compress_stored_chunked_large raw={} compressed={} ratio={:.2}x",
            raw_len,
            comp_len,
            raw_len as f64 / comp_len as f64,
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
pub struct StoreRaw<'info> {
    #[account(mut)]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StoreCompressed<'info> {
    #[account(mut)]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "chunked_lz4")]
#[derive(Accounts)]
pub struct StoreChunked<'info> {
    #[account(mut)]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompressStored<'info> {
    #[account(mut)]
    pub store: Account<'info, DataStore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReadStore<'info> {
    pub store: Account<'info, DataStore>,
}

#[cfg(feature = "chunked_lz4")]
#[derive(Accounts)]
pub struct AppendRawLarge<'info> {
    /// CHECK: owner verified by constraint; raw layout managed by instruction
    #[account(mut, owner = crate::ID)]
    pub store: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "chunked_lz4")]
#[derive(Accounts)]
pub struct CompressStoredLarge<'info> {
    /// CHECK: owner verified by constraint; discriminator checked in instruction
    #[account(mut, owner = crate::ID)]
    pub store: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
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
    #[msg("decompression failed")]
    DecompressFailed,
}
