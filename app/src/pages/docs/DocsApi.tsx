import { DocsPage, H2, H3, P, CodeBlock, Callout } from "@/components/docs/DocsComponents";

const DocsApi = () => (
  <DocsPage
    title="API Reference"
    description="Complete reference for densol's derive macro, traits, and generated methods."
  >
    <H2>#[derive(Compress)]</H2>
    <P>
      The main entry point. Applied to an Anchor <code className="code-inline">#[account]</code> struct, it generates
      compression/decompression methods for fields annotated with <code className="code-inline">#[compress]</code>.
    </P>
    <CodeBlock>{`#[account]
#[derive(Compress)]
pub struct MyAccount {
    #[compress]
    pub data: Vec<u8>,
}`}</CodeBlock>

    <H3>Requirements</H3>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>A <code className="code-inline">Strategy</code> type alias must be in scope</li>
      <li>Compressed fields must be <code className="code-inline">Vec&lt;u8&gt;</code></li>
      <li>The struct must also derive <code className="code-inline">#[account]</code> from Anchor</li>
    </ul>

    <H2>Generated methods</H2>
    <P>
      For each field named <code className="code-inline">foo</code> annotated with <code className="code-inline">#[compress]</code>,
      two methods are generated:
    </P>

    <H3>set_foo(&amp;[u8]) → Result&lt;(), densol::CompressionError&gt;</H3>
    <P>
      Compresses the input bytes using the active <code className="code-inline">Strategy</code> and stores the compressed
      output in <code className="code-inline">self.foo</code>.
    </P>
    <CodeBlock>{`// Signature
pub fn set_foo(&mut self, data: &[u8]) -> Result<(), densol::CompressionError>`}</CodeBlock>

    <H3>get_foo() → Result&lt;Vec&lt;u8&gt;, densol::CompressionError&gt;</H3>
    <P>
      Reads <code className="code-inline">self.foo</code>, decompresses using the active <code className="code-inline">Strategy</code>,
      and returns the original data.
    </P>
    <CodeBlock>{`// Signature
pub fn get_foo(&self) -> Result<Vec<u8>, densol::CompressionError>`}</CodeBlock>

    <H2>Compressor trait</H2>
    <P>
      The trait that compression strategies must implement. Implement this to add your own algorithm.
    </P>
    <CodeBlock>{`pub trait Compressor {
    const NAME: &'static str;
    const DISCRIMINANT: u8;
    fn compress(data: &[u8]) -> Result<Vec<u8>, CompressionError>;
    fn decompress(data: &[u8]) -> Result<Vec<u8>, CompressionError>;
}`}</CodeBlock>

    <H3>Built-in implementations</H3>
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Type</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Algorithm</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Memory</th>
            <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground">Feature flag</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/50 bg-table-row-alt">
            <td className="py-2.5 px-3 font-mono text-xs text-primary">Lz4</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">LZ4 via lz4_flex</td>
            <td className="py-2.5 px-3 text-xs text-muted-foreground">16 KB stack</td>
            <td className="py-2.5 px-3 font-mono text-xs">lz4</td>
          </tr>
        </tbody>
      </table>
    </div>

    <H2>Strategy type alias</H2>
    <P>
      The derive macro looks for a type alias named <code className="code-inline">Strategy</code> in the current scope
      to determine which compressor to use.
    </P>
    <CodeBlock>{`// Using built-in LZ4
use densol::Lz4 as Strategy;

// Using a custom compressor
use my_crate::MyCompressor as Strategy;`}</CodeBlock>

    <Callout type="info">
      The strategy is resolved at compile time. There is no runtime dispatch overhead.
    </Callout>

    <H2>Error types</H2>
    <P>
      densol defines its own error types that integrate with Anchor's error handling.
    </P>
    <CodeBlock>{`pub enum CompressionError {
    DecompressFailed,
    InputTooLarge,
}`}</CodeBlock>

    <Callout type="tip">
      Enable the <code className="code-inline">std</code> feature to get <code className="code-inline">std::error::Error</code> implementations
      for all error types.
    </Callout>
  </DocsPage>
);

export default DocsApi;
