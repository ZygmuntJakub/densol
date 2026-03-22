import { DocsPage, H2, H3, P, CodeBlock, Callout } from "@/components/docs/DocsComponents";

const DocsConfiguration = () => (
  <DocsPage
    title="Configuration"
    description="Configure densol features, algorithms, and behavior."
  >
    <H2>Cargo features</H2>
    <P>
      densol uses Cargo features to control which components are included. This keeps the binary size minimal
      for on-chain programs.
    </P>

    <H3>Default features</H3>
    <CodeBlock title="Cargo.toml">{`# These are enabled by default:
densol = "0.1"
# Equivalent to:
densol = { version = "0.1", features = ["lz4", "discriminant", "derive"] }`}</CodeBlock>

    <H3>Minimal configuration</H3>
    <CodeBlock title="Cargo.toml">{`# Disable defaults and pick only what you need
densol = { version = "0.1", default-features = false, features = ["lz4"] }`}</CodeBlock>

    <H2>Discriminant feature</H2>
    <P>
      Enabled by default. densol prepends a 1-byte algorithm identifier to the compressed output. This enables
      safe migration between compression algorithms.
    </P>
    <CodeBlock>{`# Byte layout with discriminant (default):
# [algorithm_id (1 byte) | compressed_data...]
#
# Without discriminant:
# [compressed_data...]`}</CodeBlock>
    <CodeBlock title="Cargo.toml">{`# To disable discriminant (not recommended):
densol = { version = "0.1", default-features = false, features = ["lz4", "derive"] }`}</CodeBlock>

    <Callout type="warning">
      Disabling <code className="code-inline">discriminant</code> after deploy requires migrating existing account data.
      Keep it enabled unless you have a specific reason to disable it.
    </Callout>

    <H2>Choosing an algorithm</H2>
    <P>
      The algorithm is selected at compile time via the <code className="code-inline">Strategy</code> type alias.
      Currently only LZ4 is built-in, but you can implement the <code className="code-inline">Compressor</code> trait
      for any algorithm.
    </P>
    <CodeBlock>{`// Default: LZ4
use densol::Lz4 as Strategy;

// Custom algorithm
use my_crate::Heatshrink as Strategy;`}</CodeBlock>

    <H2>Memory budget</H2>
    <P>
      Understanding the memory constraints helps you choose the right configuration for your program.
    </P>
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Component</th>
            <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground">Size</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Location</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/50 bg-table-row-alt">
            <td className="py-2.5 px-3 text-xs text-muted-foreground">LZ4 hash table</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-primary">16 KB</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Stack</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Input bytes</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">N bytes</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Moved (no alloc)</td>
          </tr>
          <tr className="border-b border-border/50 bg-table-row-alt">
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Output buffer</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">≈ N + 27 bytes</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Heap (1 alloc)</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2.5 px-3 text-xs text-muted-foreground">SBF heap limit</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-primary">32 KB</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">Bump allocator</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Callout type="info">
      The practical maximum data size per compression call is bounded by the 32 KB heap. For LZ4, this means
      roughly 10-15 KB of input data before running into OOM on decompression with random data.
    </Callout>
  </DocsPage>
);

export default DocsConfiguration;
