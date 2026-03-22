import { DocsPage, H2, H3, P, Callout } from "@/components/docs/DocsComponents";
import { useState } from "react";
import { motion } from "framer-motion";

const writeData = [
  { type: "repetitive", size: "256 B", compressed: "84 B", ratio: "3.05x", rawCU: "4,840", compCU: "9,800", overhead: "4,960", rent: "+1,197,120", breakeven: "241,355" },
  { type: "repetitive", size: "512 B", compressed: "85 B", ratio: "6.02x", rawCU: "4,840", compCU: "10,277", overhead: "5,437", rent: "+2,971,920", breakeven: "546,610" },
  { type: "repetitive", size: "800 B", compressed: "86 B", ratio: "9.30x", rawCU: "4,840", compCU: "10,852", overhead: "6,012", rent: "+4,969,440", breakeven: "826,587" },
  { type: "json-like", size: "256 B", compressed: "147 B", ratio: "1.74x", rawCU: "4,840", compCU: "13,473", overhead: "8,633", rent: "+758,640", breakeven: "87,877" },
  { type: "json-like", size: "512 B", compressed: "148 B", ratio: "3.46x", rawCU: "4,840", compCU: "14,018", overhead: "9,178", rent: "+2,533,440", breakeven: "276,034" },
  { type: "json-like", size: "800 B", compressed: "149 B", ratio: "5.37x", rawCU: "4,840", compCU: "14,593", overhead: "9,753", rent: "+4,530,960", breakeven: "464,571" },
  { type: "random", size: "256 B", compressed: "263 B", ratio: "0.97x", rawCU: "4,840", compCU: "11,990", overhead: "7,150", rent: "-48,720", breakeven: "harmful" },
  { type: "random", size: "512 B", compressed: "520 B", ratio: "0.98x", rawCU: "4,840", compCU: "14,630", overhead: "9,790", rent: "-55,680", breakeven: "harmful" },
  { type: "random", size: "800 B", compressed: "810 B", ratio: "0.99x", rawCU: "4,840", compCU: "16,825", overhead: "11,985", rent: "-69,600", breakeven: "harmful" },
];

const readData = [
  { type: "repetitive", size: "256 B", compressed: "84 B", ratio: "3.05x", rawCU: "4,021", compCU: "5,471", overhead: "1,450", rent: "+1,197,120", breakeven: "825,600" },
  { type: "repetitive", size: "1 KB", compressed: "87 B", ratio: "11.77x", rawCU: "11,705", compCU: "17,412", overhead: "5,707", rent: "+6,521,520", breakeven: "1,142,723" },
  { type: "repetitive", size: "4 KB", compressed: "99 B", ratio: "41.37x", rawCU: "42,441", compCU: "65,164", overhead: "22,723", rent: "+27,819,120", breakeven: "1,224,271" },
  { type: "repetitive", size: "10 KB", compressed: "123 B", ratio: "83.25x", rawCU: "103,940", compCU: "160,682", overhead: "56,742", rent: "+70,414,320", breakeven: "1,240,956" },
  { type: "json-like", size: "256 B", compressed: "147 B", ratio: "1.74x", rawCU: "4,021", compCU: "5,455", overhead: "1,434", rent: "+758,640", breakeven: "529,038" },
  { type: "json-like", size: "1 KB", compressed: "150 B", ratio: "6.83x", rawCU: "11,705", compCU: "17,395", overhead: "5,690", rent: "+6,083,040", breakeven: "1,069,076" },
  { type: "json-like", size: "4 KB", compressed: "162 B", ratio: "25.28x", rawCU: "42,441", compCU: "65,147", overhead: "22,706", rent: "+27,380,640", breakeven: "1,205,877" },
  { type: "json-like", size: "10 KB", compressed: "186 B", ratio: "55.05x", rawCU: "103,940", compCU: "160,654", overhead: "56,714", rent: "+69,975,840", breakeven: "1,233,837" },
  { type: "random", size: "256 B", compressed: "263 B", ratio: "0.97x", rawCU: "4,021", compCU: "4,480", overhead: "459", rent: "-48,720", breakeven: "harmful" },
  { type: "random", size: "1 KB", compressed: "1,034 B", ratio: "0.99x", rawCU: "11,709", compCU: "12,541", overhead: "832", rent: "-69,600", breakeven: "harmful" },
  { type: "random", size: "4 KB", compressed: "4,119 B", ratio: "0.99x", rawCU: "42,441", compCU: "44,760", overhead: "2,319", rent: "-160,080", breakeven: "harmful" },
];

const BenchTable = ({ data, type }: { data: typeof writeData; type: "write" | "read" }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-3 px-2 font-mono text-xs text-muted-foreground">Data</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Size</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Compressed</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Ratio</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">{type === "write" ? "Raw CU" : "Read CU"}</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">{type === "write" ? "Comp CU" : "Decomp CU"}</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Overhead</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Rent Δ</th>
          <th className="text-right py-3 px-2 font-mono text-xs text-muted-foreground">Break-even</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} className={`border-b border-border/50 ${i % 2 === 0 ? "bg-table-row-alt" : ""}`}>
            <td className="py-2 px-2 font-mono text-xs">{row.type}</td>
            <td className="py-2 px-2 text-right font-mono text-xs">{row.size}</td>
            <td className="py-2 px-2 text-right font-mono text-xs">{row.compressed}</td>
            <td className={`py-2 px-2 text-right font-mono text-xs ${parseFloat(row.ratio) > 1 ? "text-primary" : "text-destructive"}`}>{row.ratio}</td>
            <td className="py-2 px-2 text-right font-mono text-xs text-muted-foreground">{row.rawCU}</td>
            <td className="py-2 px-2 text-right font-mono text-xs text-muted-foreground">{row.compCU}</td>
            <td className="py-2 px-2 text-right font-mono text-xs text-muted-foreground">{row.overhead}</td>
            <td className={`py-2 px-2 text-right font-mono text-xs ${row.rent.startsWith("+") ? "text-primary" : "text-destructive"}`}>{row.rent}</td>
            <td className={`py-2 px-2 text-right font-mono text-xs ${row.breakeven === "harmful" ? "text-destructive" : "text-muted-foreground"}`}>{row.breakeven}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const DocsBenchmarks = () => {
  const [tab, setTab] = useState<"write" | "read">("write");

  return (
    <DocsPage
      title="Benchmarks"
      description="All benchmarks run on-chain with Anchor. Priority fee: 1,000 µL/CU."
    >
      <H2>Understanding the columns</H2>
      <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground mb-6">
        <li><strong className="text-foreground">Ratio</strong> — original size / compressed size (higher = better)</li>
        <li><strong className="text-foreground">Overhead CU</strong> — extra CU per operation caused by compression</li>
        <li><strong className="text-foreground">Rent saving</strong> — lamports saved on rent-exempt minimum (negative = data expanded)</li>
        <li><strong className="text-foreground">Break-even</strong> — operations until CU cost equals rent saving (at 1,000 µL/CU priority fee)</li>
      </ul>

      <div className="flex gap-1 mb-4 p-1 bg-secondary rounded-lg w-fit">
        {(["write", "read"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === t ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "write" ? "Write Benchmark" : "Read Benchmark"}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
        className="rounded-lg border border-border bg-card overflow-hidden mb-8">
        <BenchTable data={tab === "write" ? writeData : readData} type={tab} />
      </motion.div>

      <H2>Conclusion</H2>
      <P>
        For structured data, the rent saving is immediate and permanent. You pay less rent from the moment the account is created.
        The extra CU cost per operation is small enough that it would take hundreds of thousands of operations to spend back what you saved.
        Compression is a clear win for structured data.
      </P>

      <Callout type="warning">
        Rent is refunded in full when you close the account. If the account is short-lived, the rent saving evaporates
        the moment you close it. Compression makes the most sense for long-lived accounts.
      </Callout>

      <H2>Data types tested</H2>
      <H3>Repetitive (best case)</H3>
      <P>Synthetic data with high repetition. Represents the ceiling of compression performance.</P>
      <H3>JSON-like (realistic)</H3>
      <P>Synthetic structured data resembling real-world payloads like order books, metadata, or game state.</P>
      <H3>Random (worst case)</H3>
      <P>Pseudo-random bytes that are incompressible. LZ4 slightly expands this data, making compression harmful.</P>
    </DocsPage>
  );
};

export default DocsBenchmarks;
