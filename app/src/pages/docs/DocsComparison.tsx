import { DocsPage, H2, H3, P, Callout } from "@/components/docs/DocsComponents";

const DocsComparison = () => (
  <DocsPage
    title="Comparison"
    description="How densol compares to other data optimization approaches on Solana."
  >
    <H2>densol vs ZK Compression vs SPL Compression</H2>
    <div className="overflow-x-auto my-6">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-3 font-medium text-muted-foreground"></th>
            <th className="text-left py-3 px-3 font-mono text-xs text-primary font-medium">densol</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground font-medium">ZK Compression</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground font-medium">SPL Compression</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {[
            { label: "Data location", densol: "On-chain", zk: "Off-chain", spl: "Off-chain (Merkle)" },
            { label: "CU cost", densol: "10-15K", zk: "~292K", spl: "Variable" },
            { label: "Scope", densol: "Any Anchor field", zk: "Specific programs", spl: "NFTs only" },
            { label: "Architecture change", densol: "None", zk: "Significant", spl: "Moderate" },
            { label: "Proof required", densol: "No", zk: "ZK proof", spl: "Merkle proof" },
            { label: "Composability", densol: "Full (data on-chain)", zk: "Limited", spl: "Limited" },
            { label: "Read pattern", densol: "Direct account read", zk: "Proof verification", spl: "Proof verification" },
            { label: "Best for", densol: "Any structured data", zk: "Massive scale", spl: "NFT collections" },
          ].map((row, i) => (
            <tr key={row.label} className={`border-b border-border/50 ${i % 2 === 0 ? "bg-table-row-alt" : ""}`}>
              <td className="py-2.5 px-3 text-muted-foreground">{row.label}</td>
              <td className="py-2.5 px-3 text-primary">{row.densol}</td>
              <td className="py-2.5 px-3">{row.zk}</td>
              <td className="py-2.5 px-3">{row.spl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <H2>When to use densol</H2>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>You have an existing Anchor program and want to reduce rent without rewriting</li>
      <li>Your data needs to be fully on-chain and directly readable by other programs</li>
      <li>You're storing structured or repetitive data (JSON-like, serialized structs, game state)</li>
      <li>Your accounts are long-lived (rent savings compound over time)</li>
      <li>You need low CU overhead per operation</li>
    </ul>

    <H2>When NOT to use densol</H2>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>Your data is random or already compressed — LZ4 will expand it</li>
      <li>Your accounts are very short-lived — rent is refunded on close</li>
      <li>You need to compress millions of accounts — ZK Compression may be more cost-effective at massive scale</li>
      <li>You only need to compress NFTs — SPL Compression is purpose-built for that</li>
    </ul>

    <Callout type="info">
      densol and ZK Compression are not mutually exclusive. You could use densol for your hot, frequently-accessed
      accounts and ZK Compression for cold storage of historical data.
    </Callout>

    <H2>Cost comparison example</H2>
    <P>
      For a 512-byte JSON-like account with 10 writes/day over 1 year:
    </P>
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Approach</th>
            <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground">Rent cost</th>
            <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground">CU overhead/year</th>
            <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground">Net cost</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/50 bg-table-row-alt">
            <td className="py-2.5 px-3 text-xs">No compression</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">4.45M lamports</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">0</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">4.45M lamports</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2.5 px-3 text-xs text-primary">With densol</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-primary">1.92M lamports</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">~22K lamports</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-primary">1.94M lamports</td>
          </tr>
        </tbody>
      </table>
    </div>
    <P>
      That's a <strong className="text-primary">56% cost reduction</strong> even after accounting for the extra CU.
    </P>
  </DocsPage>
);

export default DocsComparison;
