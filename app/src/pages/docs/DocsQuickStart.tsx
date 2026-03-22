import { DocsPage, Callout, H2, P, CodeBlock } from "@/components/docs/DocsComponents";

const DocsQuickStart = () => (
  <DocsPage
    title="Quick Start"
    description="Add compression to your Anchor account in 5 minutes."
  >
    <H2>Step 1: Import</H2>
    <P>
      Import the compression strategy and derive macro. The <code className="code-inline">Strategy</code> type alias
      tells the macro which algorithm to use.
    </P>
    <CodeBlock title="lib.rs">{`use densol::Lz4 as Strategy;
use densol::Compress;`}</CodeBlock>

    <H2>Step 2: Annotate your struct</H2>
    <P>
      Add <code className="code-inline">#[derive(Compress)]</code> to your account struct and mark
      the <code className="code-inline">Vec&lt;u8&gt;</code> fields you want compressed with <code className="code-inline">#[compress]</code>.
    </P>
    <CodeBlock title="lib.rs">{`#[account]
#[derive(Compress)]
pub struct MyAccount {
    pub authority: Pubkey,
    #[compress]
    pub data: Vec<u8>,
    pub counter: u64,  // non-compressed fields work normally
}`}</CodeBlock>

    <Callout type="info">
      Only <code className="code-inline">Vec&lt;u8&gt;</code> fields can be compressed. Other field types are left unchanged.
    </Callout>

    <H2>Step 3: Use the generated methods</H2>
    <P>
      The derive macro generates <code className="code-inline">set_&lt;field&gt;</code> and <code className="code-inline">get_&lt;field&gt;</code> methods
      for each compressed field.
    </P>
    <CodeBlock title="Storing compressed data">{`pub fn store_data(ctx: Context<StoreData>, raw_bytes: Vec<u8>) -> Result<()> {
    let account = &mut ctx.accounts.my_account;
    account.set_data(&raw_bytes)?;  // compress + store
    Ok(())
}`}</CodeBlock>

    <CodeBlock title="Reading compressed data">{`pub fn read_data(ctx: Context<ReadData>) -> Result<()> {
    let account = &ctx.accounts.my_account;
    let raw = account.get_data()?;  // load + decompress
    msg!("Data length: {}", raw.len());
    Ok(())
}`}</CodeBlock>

    <H2>Step 4: Build and test</H2>
    <CodeBlock>{`anchor build
anchor test`}</CodeBlock>

    <Callout type="tip">
      The account will store compressed bytes on-chain. The rent-exempt minimum is calculated on the compressed size,
      so you pay less rent immediately.
    </Callout>

    <H2>What's happening under the hood</H2>
    <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li><code className="code-inline">set_data()</code> takes your raw bytes, compresses them with LZ4, and writes the compressed output to the account field</li>
      <li>The account stores only the compressed bytes, reducing its size and therefore its rent</li>
      <li><code className="code-inline">get_data()</code> reads the compressed bytes and decompresses them back to the original data</li>
      <li>LZ4's hash table lives on the stack (16 KB), so the 32 KB SBF heap limit is respected</li>
    </ol>
  </DocsPage>
);

export default DocsQuickStart;
