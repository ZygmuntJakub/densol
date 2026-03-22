import { DocsPage, Callout, H2, H3, P, CodeBlock } from "@/components/docs/DocsComponents";

const DocsInstallation = () => (
  <DocsPage
    title="Installation"
    description="Add densol to your Anchor project in under a minute."
  >
    <H2>Prerequisites</H2>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li><a href="https://rustup.rs/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Rust</a> (latest stable)</li>
      <li><a href="https://docs.solana.com/cli/install-solana-cli-tools" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Solana CLI</a></li>
      <li><a href="https://www.anchor-lang.com/docs/installation" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Anchor</a></li>
    </ul>

    <H2>Add the dependency</H2>
    <CodeBlock title="Cargo.toml">{`[dependencies]
densol = "0.1"`}</CodeBlock>

    <H3>With specific features</H3>
    <CodeBlock title="Cargo.toml">{`[dependencies]
densol = { version = "0.1", default-features = false, features = ["lz4", "discriminant"] }`}</CodeBlock>

    <H2>Available features</H2>
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Feature</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Default</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Description</th>
          </tr>
        </thead>
        <tbody>
          {[
            { name: "lz4", def: "✓", desc: "LZ4 strategy via lz4_flex" },
            { name: "derive", def: "✓", desc: "Re-exports #[derive(Compress)]" },
            { name: "discriminant", def: "✓", desc: "1-byte algorithm tag prepended to output" },
            { name: "std", def: "✗", desc: "Implements std::error::Error for errors" },
          ].map((f, i) => (
            <tr key={f.name} className={`border-b border-border/50 ${i % 2 === 0 ? "bg-table-row-alt" : ""}`}>
              <td className="py-2.5 px-3 font-mono text-xs text-primary">{f.name}</td>
              <td className="py-2.5 px-3 font-mono text-xs">{f.def}</td>
              <td className="py-2.5 px-3 text-xs text-muted-foreground">{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <H2>Verify installation</H2>
    <CodeBlock>{`anchor build`}</CodeBlock>
    <P>
      If the build succeeds, densol is ready to use. Head to the Quick Start guide to compress your first field.
    </P>

    <Callout type="info">
      densol is published on <a href="https://crates.io/crates/densol" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">crates.io</a>.
      Make sure you're using the latest version.
    </Callout>
  </DocsPage>
);

export default DocsInstallation;
