export const UsageSection = () => {
  return (
    <section id="usage" className="py-24 px-6 border-t border-border">
      <div className="max-w-3xl mx-auto">
        <p className="section-label">API Reference</p>
        <h2 className="text-3xl font-bold mb-8">Usage</h2>

        <div className="space-y-10">
          <div>
            <h3 className="text-lg font-semibold mb-3">Derive Macro</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Add <code className="code-inline">#[derive(Compress)]</code> to your Anchor account struct and mark fields
              with <code className="code-inline">#[compress]</code>.
            </p>
            <pre className="code-block">
              <code>{`use densol::Lz4 as Strategy;
use densol::Compress;

#[account]
#[derive(Compress)]
pub struct OrderBook {
    pub authority: Pubkey,
    #[compress]
    pub orders: Vec<u8>,   // compressed on write, decompressed on read
    pub order_count: u32,  // normal field, uncompressed
}`}</code>
            </pre>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-3">Generated Methods</h3>
            <p className="text-sm text-muted-foreground mb-4">
              For each <code className="code-inline">#[compress]</code> field, two methods are generated:
            </p>
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-card p-4">
                <code className="code-inline text-foreground">account.set_data(&[u8]) → Result&lt;()&gt;</code>
                <p className="text-sm text-muted-foreground mt-2">
                  Compresses the input bytes using the selected strategy and stores the result in the account field.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <code className="code-inline text-foreground">account.get_data() → Result&lt;Vec&lt;u8&gt;&gt;</code>
                <p className="text-sm text-muted-foreground mt-2">
                  Reads the compressed bytes from the account, decompresses, and returns the original data.
                </p>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-3">Switching Algorithms</h3>
            <p className="text-sm text-muted-foreground mb-4">
              The <code className="code-inline">Strategy</code> type alias determines which compressor is used at compile time.
              Implement the <code className="code-inline">Compressor</code> trait to add your own algorithm.
            </p>
            <pre className="code-block">
              <code>{`// Use a different algorithm
use my_crate::Heatshrink as Strategy;
use densol::Compress;

// The same derive macro works with any Compressor impl
#[account]
#[derive(Compress)]
pub struct MyAccount {
    #[compress]
    pub payload: Vec<u8>,
}`}</code>
            </pre>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-3">Discriminant Feature</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Enable the <code className="code-inline">discriminant</code> feature to prepend a 1-byte tag identifying
              the algorithm. This enables safe migration between compression strategies.
            </p>
            <pre className="code-block">
              <code>{`# Cargo.toml
densol = { version = "0.1", features = ["lz4", "discriminant"] }

# Byte layout: [algorithm_id | compressed_data...]`}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
};
