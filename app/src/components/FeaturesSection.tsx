import { motion } from "framer-motion";
import { Layers, Zap, Shield, Settings } from "lucide-react";

const features = [
  {
    icon: Layers,
    title: "Fully On-Chain",
    description: "Data stays in the account. No Merkle proofs, no off-chain indexers, no external dependencies.",
  },
  {
    icon: Zap,
    title: "Low CU Overhead",
    description: "LZ4 keeps its hash table on the stack (16 KB). Compression costs 10-15K CU per write.",
  },
  {
    icon: Shield,
    title: "SBF Compatible",
    description: "Fits within the 32 KB SBF heap limit. Stack-allocated hash table avoids heap pressure.",
  },
  {
    icon: Settings,
    title: "Drop-in for Anchor",
    description: "One derive macro, one attribute. No architecture changes to your existing program.",
  },
];

const cargoFeatures = [
  { name: "lz4", description: "LZ4 strategy via lz4_flex", default: true },
  { name: "discriminant", description: "1-byte algorithm tag prepended to output", default: false },
  { name: "derive", description: "Re-exports #[derive(Compress)]", default: true },
  { name: "std", description: "Implements std::error::Error for errors", default: false },
];

export const FeaturesSection = () => {
  return (
    <section id="features" className="py-24 px-6 border-t border-border">
      <div className="max-w-3xl mx-auto">
        <p className="section-label">Features</p>
        <h2 className="text-3xl font-bold mb-12">Built for Solana's constraints</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-16">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              className="rounded-lg border border-border bg-card p-6"
            >
              <f.icon className="w-5 h-5 text-primary mb-3" />
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </motion.div>
          ))}
        </div>

        <div>
          <h3 className="text-xl font-semibold mb-4">Cargo Features</h3>
          <pre className="code-block mb-6">
            <code>{`densol = { version = "0.1", default-features = false, features = ["lz4", "discriminant"] }`}</code>
          </pre>
          <div className="space-y-3">
            {cargoFeatures.map((f) => (
              <div key={f.name} className="flex items-start gap-3">
                <code className="code-inline flex-shrink-0">{f.name}</code>
                <span className="text-sm text-muted-foreground">{f.description}</span>
                {f.default && (
                  <span className="ml-auto text-xs text-primary font-mono flex-shrink-0">default</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
