import { DocsPage, H2, H3, P, CodeBlock, Callout } from "@/components/docs/DocsComponents";

const DocsTroubleshooting = () => (
  <DocsPage
    title="Troubleshooting"
    description="Common issues and how to solve them."
  >
    <H2>OOM (Out of Memory) errors</H2>
    <H3>Symptom</H3>
    <P>Your program fails with a memory allocation error during compression or decompression.</P>
    <H3>Cause</H3>
    <P>
      The SBF runtime has a 32 KB heap limit. If your input data is too large, the output buffer allocation
      will exceed this limit. Random/incompressible data is particularly problematic because LZ4 may expand it.
    </P>
    <H3>Solution</H3>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>Keep input data under ~10 KB for structured data</li>
      <li>For random data, keep it under ~4 KB</li>
      <li>Consider splitting large payloads across multiple accounts</li>
      <li>Use the break-even calculator to check if compression is worth it for your data type</li>
    </ul>

    <H2>Data expanded after compression</H2>
    <H3>Symptom</H3>
    <P>The compressed output is larger than the input. Rent increased instead of decreased.</P>
    <H3>Cause</H3>
    <P>
      LZ4 cannot compress random or already-compressed data. It adds a small overhead (~7 bytes) that makes
      incompressible data slightly larger.
    </P>
    <H3>Solution</H3>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>Only compress structured, repetitive, or serialized data</li>
      <li>Test compression ratios with your actual data before deploying</li>
      <li>The upcoming auto-switching feature will automatically skip compression for incompressible data</li>
    </ul>

    <Callout type="tip">
      If you're unsure whether your data is compressible, run a test with <code className="code-inline">anchor test</code> and
      compare the account sizes.
    </Callout>

    <H2>"Strategy" type not found</H2>
    <H3>Symptom</H3>
    <CodeBlock>{"error[E0412]: cannot find type `Strategy` in this scope"}</CodeBlock>
    <H3>Solution</H3>
    <P>
      The derive macro requires a type alias named <code className="code-inline">Strategy</code> in scope.
      Add it before your struct definition:
    </P>
    <CodeBlock>{`use densol::Lz4 as Strategy;  // Add this line
use densol::Compress;`}</CodeBlock>

    <H2>Anchor version compatibility</H2>
    <P>
      densol is tested with Anchor 0.32.1+. If you encounter issues with an older version,
      please open a GitHub issue.
    </P>

    <H2>Build errors with no_std</H2>
    <H3>Symptom</H3>
    <P>Compilation fails when targeting no_std environments.</P>
    <H3>Solution</H3>
    <P>
      Make sure you're not enabling the <code className="code-inline">std</code> feature:
    </P>
    <CodeBlock>{`densol = { version = "0.1", default-features = false, features = ["lz4"] }`}</CodeBlock>

    <H2>Getting help</H2>
    <P>
      If your issue isn't covered here:
    </P>
    <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
      <li>
        <a href="https://github.com/ZygmuntJakub/densol/issues" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          Open a GitHub issue
        </a>
      </li>
      <li>Include your Anchor version, Solana CLI version, and the full error message</li>
      <li>If possible, include a minimal reproduction</li>
    </ul>
  </DocsPage>
);

export default DocsTroubleshooting;
