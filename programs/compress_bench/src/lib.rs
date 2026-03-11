use anchor_lang::prelude::*;
use densol_derive::Compress;

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
