import { motion } from "framer-motion";

const steps = [
  {
    step: "1",
    title: "Add dependency",
    code: `# Cargo.toml
[dependencies]
densol = "0.1"`,
  },
  {
    step: "2",
    title: "Import and derive",
    code: `use densol::Lz4 as Strategy;
use densol::Compress;

#[account]
#[derive(Compress)]
pub struct MyAccount {
    #[compress]
    pub data: Vec<u8>,
}`,
  },
  {
    step: "3",
    title: "Use generated methods",
    code: `// Compress + store
account.set_data(&raw_bytes)?;

// Load + decompress
let raw = account.get_data()?;`,
  },
];

export const QuickStartSection = () => {
  return (
    <section id="quickstart" className="py-24 px-6 border-t border-border">
      <div className="max-w-3xl mx-auto">
        <p className="section-label">Quick Start</p>
        <h2 className="text-3xl font-bold mb-4">Add compression in 5 minutes</h2>
        <p className="text-muted-foreground mb-12 max-w-lg">
          Three steps to compress any <code className="code-inline">Vec&lt;u8&gt;</code> field in your Anchor account.
        </p>

        <div className="space-y-8">
          {steps.map((s, i) => (
            <motion.div
              key={s.step}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: i * 0.1, duration: 0.4 }}
              className="flex gap-5"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-mono text-sm font-bold">
                {s.step}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground mb-3">{s.title}</h3>
                <pre className="code-block">
                  <code>{s.code}</code>
                </pre>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="mt-12 p-4 rounded-lg border border-primary/20 bg-primary/5">
          <p className="text-sm text-muted-foreground">
            <span className="text-primary font-mono font-semibold">Strategy</span> alias tells the derive macro which algorithm to use.
            Swap it for a different type implementing <code className="code-inline">Compressor</code> to change algorithms at compile time.
          </p>
        </div>
      </div>
    </section>
  );
};
