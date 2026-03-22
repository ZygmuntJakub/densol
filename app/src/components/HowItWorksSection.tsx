export const HowItWorksSection = () => {
  return (
    <section id="how-it-works" className="py-24 px-6 border-t border-border">
      <div className="max-w-3xl mx-auto">
        <p className="section-label">Deep Dive</p>
        <h2 className="text-3xl font-bold mb-4">How it works</h2>
        <p className="text-muted-foreground mb-12 max-w-lg">
          Understanding the constraints and trade-offs of on-chain compression.
        </p>

        <div className="space-y-12">
          <div>
            <h3 className="text-xl font-semibold mb-3">The Problem</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              Solana accounts store data and hold tokens. More data = more rent, deposited upfront and refunded on close.
              Creating a market on OpenBook costs 3-4 SOL just in rent. The Solana Foundation has an open discussion about
              reducing rent by 10x. Most protocols can't afford a full rewrite to solve this.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              densol gives any existing Anchor program a way to reduce account size without changing architecture.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-3">SBF Runtime Constraints</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              SBF (Solana Binary Format) is executed by the RBPF runtime. The critical constraint: a 32 KB bump allocator heap.
              This rules out zstd, gzip, and most compression libraries.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-3">Why LZ4?</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              <code className="code-inline">lz4_flex</code> has a unique property: its hash table is stack-allocated.
            </p>
            <pre className="code-block">
              <code>{`// Memory layout during compression:
[u32; 4096] = 16 KB   ← stack (hash table)
raw bytes   = N        ← moved from account (no new alloc)
output buf  ≈ N + 27   ← one heap alloc`}</code>
            </pre>
            <p className="text-sm text-muted-foreground leading-relaxed mt-4">
              The hash table sits on the SBF stack frame, not the heap. This means the only heap allocation during
              compression is the output buffer.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-3">vs. ZK Compression & SPL Compression</h3>
            <div className="overflow-x-auto">
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
                  <tr className="border-b border-border/50 bg-table-row-alt">
                    <td className="py-2.5 px-3 text-muted-foreground">Data location</td>
                    <td className="py-2.5 px-3 text-primary">On-chain</td>
                    <td className="py-2.5 px-3">Off-chain</td>
                    <td className="py-2.5 px-3">Off-chain (Merkle)</td>
                  </tr>
                  <tr className="border-b border-border/50">
                    <td className="py-2.5 px-3 text-muted-foreground">CU cost</td>
                    <td className="py-2.5 px-3 text-primary">10-15K</td>
                    <td className="py-2.5 px-3">~292K</td>
                    <td className="py-2.5 px-3">Variable</td>
                  </tr>
                  <tr className="border-b border-border/50 bg-table-row-alt">
                    <td className="py-2.5 px-3 text-muted-foreground">Scope</td>
                    <td className="py-2.5 px-3 text-primary">Any Anchor field</td>
                    <td className="py-2.5 px-3">Specific programs</td>
                    <td className="py-2.5 px-3">NFTs only</td>
                  </tr>
                  <tr className="border-b border-border/50">
                    <td className="py-2.5 px-3 text-muted-foreground">Architecture change</td>
                    <td className="py-2.5 px-3 text-primary">None</td>
                    <td className="py-2.5 px-3">Significant</td>
                    <td className="py-2.5 px-3">Moderate</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
