import { DocsPage, Callout, H2, H3, P, CodeBlock } from "@/components/docs/DocsComponents";
import { Link } from "react-router-dom";

const DocsIntroduction = () => (
  <DocsPage
    title="Introduction"
    description="densol is an open-source Rust library that brings transparent LZ4 compression to Solana Anchor account fields."
  >
    <H2>What is densol?</H2>
    <P>
      densol lets you compress a <code className="code-inline">Vec&lt;u8&gt;</code> field inside any Anchor account with a single
      attribute. The compression runs fully on-chain using LZ4 via lz4_flex, which keeps its hash table on the stack (16 KB)
      and stays within the SBF VM's 32 KB heap limit.
    </P>
    <P>
      The library was built to answer a question that couldn't be found answered anywhere: <em>is on-chain compression
      actually worth the extra compute units?</em> So it was measured.
    </P>

    <H2>Why compression?</H2>
    <P>
      Solana accounts store data and hold tokens. More data means more rent, deposited upfront and refunded when the account is closed.
      Creating a market on OpenBook costs 3-4 SOL in rent just for account storage. The Solana Foundation has an open discussion
      about reducing rent by 10x.
    </P>
    <P>
      Most protocols cannot afford a full architectural rewrite. densol gives any existing Anchor program a way to reduce
      account size without changing the architecture.
    </P>

    <Callout type="tip">
      For structured data, benchmarks show up to <strong>9x compression ratio</strong> and over <strong>4,900,000 lamports saved</strong> per account
      at 10,000-15,000 CU per write.
    </Callout>

    <H2>Key features</H2>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li><strong className="text-foreground">Fully on-chain</strong> — no Merkle proofs, no off-chain indexers</li>
      <li><strong className="text-foreground">Low CU overhead</strong> — 10-15K CU per write operation</li>
      <li><strong className="text-foreground">SBF compatible</strong> — fits within 32 KB heap limit</li>
      <li><strong className="text-foreground">Drop-in for Anchor</strong> — one derive macro, one attribute</li>
      <li><strong className="text-foreground">Pluggable algorithms</strong> — swap compressors at compile time</li>
    </ul>

    <H2>Quick example</H2>
    <CodeBlock title="lib.rs">{`use densol::Lz4 as Strategy;
use densol::Compress;

#[account]
#[derive(Compress)]
pub struct MyAccount {
    #[compress]
    pub data: Vec<u8>,
}

// Generated methods:
// account.set_data(&raw_bytes)?;  // compress + store
// account.get_data()?;            // load + decompress`}</CodeBlock>

    <P>
      Ready to get started? Head to the{" "}
      <Link to="/docs/installation" className="text-primary hover:underline">Installation</Link> page.
    </P>
  </DocsPage>
);

export default DocsIntroduction;
