use anchor_lang::prelude::*;

declare_id!("...");

#[program]
pub mod openbook_v3 {
    use super::*;

    pub fn place_order(ctx: Context<PlaceOrder>, order: Vec<u8>) -> Result<()> {
        ctx.accounts.book_side.orders.extend_from_slice(&order);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub book_side: Account<'info, BookSide>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct BookSide {
    pub market: Pubkey,
    pub is_bids: bool,
    pub orders: Vec<u8>,
}
