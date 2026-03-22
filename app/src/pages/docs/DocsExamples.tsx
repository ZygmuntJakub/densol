import { DocsPage, H2, H3, P, CodeBlock, Callout } from "@/components/docs/DocsComponents";

const DocsExamples = () => (
  <DocsPage
    title="Examples"
    description="Real-world patterns for using densol in your Solana programs."
  >
    <H2>Compressed orderbook</H2>
    <P>
      On-chain orderbooks are one of the best use cases for densol. Order data is highly structured and repetitive,
      yielding excellent compression ratios.
    </P>
    <CodeBlock title="programs/orderbook/src/lib.rs">{`use anchor_lang::prelude::*;
use densol::Lz4 as Strategy;
use densol::Compress;

declare_id!("...");

#[program]
pub mod orderbook {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let book = &mut ctx.accounts.order_book;
        book.authority = ctx.accounts.authority.key();
        book.order_count = 0;
        Ok(())
    }

    pub fn place_order(ctx: Context<PlaceOrder>, order_data: Vec<u8>) -> Result<()> {
        let book = &mut ctx.accounts.order_book;
        book.set_orders(&order_data)?;
        book.order_count += 1;
        Ok(())
    }

    pub fn read_orders(ctx: Context<ReadOrders>) -> Result<()> {
        let book = &ctx.accounts.order_book;
        let orders = book.get_orders()?;
        msg!("Orders: {} bytes", orders.len());
        Ok(())
    }
}

#[account]
#[derive(Compress)]
pub struct OrderBook {
    pub authority: Pubkey,
    #[compress]
    pub orders: Vec<u8>,
    pub order_count: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 4 + 256 + 8)]
    pub order_book: Account<'info, OrderBook>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut, has_one = authority)]
    pub order_book: Account<'info, OrderBook>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReadOrders<'info> {
    pub order_book: Account<'info, OrderBook>,
}`}</CodeBlock>

    <Callout type="tip">
      With JSON-like order data, you can expect roughly 3-5x compression, saving 2.5M+ lamports per account.
    </Callout>

    <H2>Game state storage</H2>
    <P>
      On-chain games often store large game states per player account. Compression reduces the per-player
      rent cost significantly.
    </P>
    <CodeBlock title="programs/game/src/lib.rs">{`use densol::Lz4 as Strategy;
use densol::Compress;

#[account]
#[derive(Compress)]
pub struct PlayerState {
    pub player: Pubkey,
    #[compress]
    pub game_data: Vec<u8>,   // serialized game state
    pub level: u32,
    pub last_action: i64,
}`}</CodeBlock>

    <H2>Multiple compressed fields</H2>
    <P>
      You can compress multiple fields in the same account. Each gets its own
      <code className="code-inline">set_</code> / <code className="code-inline">get_</code> methods.
    </P>
    <CodeBlock>{`#[account]
#[derive(Compress)]
pub struct MultiField {
    #[compress]
    pub metadata: Vec<u8>,
    #[compress]
    pub payload: Vec<u8>,
    pub version: u8,
}

// Generated:
// account.set_metadata(&bytes)?;
// account.get_metadata()?;
// account.set_payload(&bytes)?;
// account.get_payload()?;`}</CodeBlock>

    <H2>Serializing structs before compression</H2>
    <P>
      densol compresses raw bytes. If you have a Rust struct, serialize it first (e.g., with Borsh), then compress.
    </P>
    <CodeBlock>{`use borsh::{BorshSerialize, BorshDeserialize};

#[derive(BorshSerialize, BorshDeserialize)]
pub struct OrderData {
    pub price: u64,
    pub quantity: u64,
    pub side: u8,
}

// Serialize, then compress
let order = OrderData { price: 100, quantity: 50, side: 1 };
let bytes = order.try_to_vec()?;
account.set_orders(&bytes)?;

// Decompress, then deserialize
let raw = account.get_orders()?;
let order = OrderData::try_from_slice(&raw)?;`}</CodeBlock>

    <Callout type="info">
      Borsh-serialized structs with numeric fields tend to compress well because of repeated byte patterns.
    </Callout>
  </DocsPage>
);

export default DocsExamples;
