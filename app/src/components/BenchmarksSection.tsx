import { useState } from "react";
import { motion } from "framer-motion";

const writeData = [
  { type: "repetitive", size: "256 B", compressed: "84 B",  ratio: "3.05x",  rawCU: "4,840", compCU: "9,800",  overhead: "4,960",  rent: "+1,197,120", breakeven: "241,355" },
  { type: "repetitive", size: "512 B", compressed: "85 B",  ratio: "6.02x",  rawCU: "4,840", compCU: "10,277", overhead: "5,437",  rent: "+2,971,920", breakeven: "546,610" },
  { type: "repetitive", size: "800 B", compressed: "86 B",  ratio: "9.30x",  rawCU: "4,840", compCU: "10,852", overhead: "6,012",  rent: "+4,969,440", breakeven: "826,587" },
  { type: "json-like",  size: "256 B", compressed: "147 B", ratio: "1.74x",  rawCU: "4,840", compCU: "13,473", overhead: "8,633",  rent: "+758,640",   breakeven: "87,877"  },
  { type: "json-like",  size: "512 B", compressed: "148 B", ratio: "3.46x",  rawCU: "4,840", compCU: "14,018", overhead: "9,178",  rent: "+2,533,440", breakeven: "276,034" },
  { type: "json-like",  size: "800 B", compressed: "149 B", ratio: "5.37x",  rawCU: "4,840", compCU: "14,593", overhead: "9,753",  rent: "+4,530,960", breakeven: "464,571" },
  { type: "orderbook",  size: "256 B", compressed: "38 B",  ratio: "6.74x",  rawCU: "4,840", compCU: "8,663",  overhead: "3,823",  rent: "+1,517,280", breakeven: "396,882" },
  { type: "orderbook",  size: "512 B", compressed: "39 B",  ratio: "13.13x", rawCU: "4,840", compCU: "9,204",  overhead: "4,364",  rent: "+3,292,080", breakeven: "754,372" },
  { type: "orderbook",  size: "800 B", compressed: "40 B",  ratio: "20.00x", rawCU: "4,840", compCU: "11,025", overhead: "6,185",  rent: "+5,289,600", breakeven: "855,230" },
  { type: "random",     size: "256 B", compressed: "263 B", ratio: "0.97x",  rawCU: "4,840", compCU: "11,990", overhead: "7,150",  rent: "-48,720",    breakeven: "harmful" },
  { type: "random",     size: "512 B", compressed: "520 B", ratio: "0.98x",  rawCU: "4,840", compCU: "14,630", overhead: "9,790",  rent: "-55,680",    breakeven: "harmful" },
  { type: "random",     size: "800 B", compressed: "810 B", ratio: "0.99x",  rawCU: "4,840", compCU: "16,825", overhead: "11,985", rent: "-69,600",    breakeven: "harmful" },
];

const readData = [
  { type: "repetitive", size: "256 B",  compressed: "84 B",    ratio: "3.05x",   rawCU: "4,021",   compCU: "5,483",   overhead: "1,462",  rent: "+1,197,120",  breakeven: "818,824"   },
  { type: "repetitive", size: "1 KB",   compressed: "87 B",    ratio: "11.77x",  rawCU: "11,705",  compCU: "17,424",  overhead: "5,719",  rent: "+6,521,520",  breakeven: "1,140,325" },
  { type: "repetitive", size: "4 KB",   compressed: "99 B",    ratio: "41.37x",  rawCU: "42,441",  compCU: "65,176",  overhead: "22,735", rent: "+27,819,120", breakeven: "1,223,625" },
  { type: "repetitive", size: "10 KB",  compressed: "123 B",   ratio: "83.25x",  rawCU: "103,940", compCU: "160,694", overhead: "56,754", rent: "+70,414,320", breakeven: "1,240,694" },
  { type: "json-like",  size: "256 B",  compressed: "147 B",   ratio: "1.74x",   rawCU: "4,021",   compCU: "5,455",   overhead: "1,434",  rent: "+758,640",    breakeven: "529,038"   },
  { type: "json-like",  size: "1 KB",   compressed: "150 B",   ratio: "6.83x",   rawCU: "11,705",  compCU: "17,395",  overhead: "5,690",  rent: "+6,083,040",  breakeven: "1,069,076" },
  { type: "json-like",  size: "4 KB",   compressed: "162 B",   ratio: "25.28x",  rawCU: "42,441",  compCU: "65,147",  overhead: "22,706", rent: "+27,380,640", breakeven: "1,205,877" },
  { type: "json-like",  size: "10 KB",  compressed: "186 B",   ratio: "55.05x",  rawCU: "103,940", compCU: "160,654", overhead: "56,714", rent: "+69,975,840", breakeven: "1,233,837" },
  { type: "orderbook",  size: "256 B",  compressed: "38 B",    ratio: "6.74x",   rawCU: "4,010",   compCU: "5,794",   overhead: "1,784",  rent: "+1,517,280",  breakeven: "850,493"   },
  { type: "orderbook",  size: "1 KB",   compressed: "41 B",    ratio: "24.98x",  rawCU: "11,705",  compCU: "17,746",  overhead: "6,041",  rent: "+6,841,680",  breakeven: "1,132,541" },
  { type: "orderbook",  size: "4 KB",   compressed: "53 B",    ratio: "77.28x",  rawCU: "42,437",  compCU: "65,494",  overhead: "23,057", rent: "+28,139,280", breakeven: "1,220,422" },
  { type: "orderbook",  size: "10 KB",  compressed: "77 B",    ratio: "132.99x", rawCU: "103,940", compCU: "161,005", overhead: "57,065", rent: "+70,734,480", breakeven: "1,239,542" },
  { type: "random",     size: "256 B",  compressed: "263 B",   ratio: "0.97x",   rawCU: "4,021",   compCU: "4,496",   overhead: "475",    rent: "-48,720",     breakeven: "harmful"   },
  { type: "random",     size: "1 KB",   compressed: "1,034 B", ratio: "0.99x",   rawCU: "11,709",  compCU: "12,557",  overhead: "848",    rent: "-69,600",     breakeven: "harmful"   },
  { type: "random",     size: "4 KB",   compressed: "4,119 B", ratio: "0.99x",   rawCU: "42,441",  compCU: "44,776",  overhead: "2,335",  rent: "-160,080",    breakeven: "harmful"   },
];

const BenchmarkTable = ({ data, type }: { data: typeof writeData; type: "write" | "read" }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Data</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Size</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Compressed</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Ratio</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">{type === "write" ? "Raw CU" : "Read CU"}</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">{type === "write" ? "Comp CU" : "Decomp CU"}</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Overhead</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Rent Δ</th>
          <th className="text-right py-3 px-3 font-mono text-xs text-muted-foreground font-medium">Break-even</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} className={`border-b border-border/50 ${i % 2 === 0 ? "bg-table-row-alt" : ""}`}>
            <td className="py-2.5 px-3 font-mono text-xs">{row.type}</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">{row.size}</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs">{row.compressed}</td>
            <td className={`py-2.5 px-3 text-right font-mono text-xs ${parseFloat(row.ratio) > 1 ? "text-primary" : "text-destructive"}`}>
              {row.ratio}
            </td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-muted-foreground">{row.rawCU}</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-muted-foreground">{row.compCU}</td>
            <td className="py-2.5 px-3 text-right font-mono text-xs text-muted-foreground">{row.overhead}</td>
            <td className={`py-2.5 px-3 text-right font-mono text-xs ${row.rent.startsWith("+") ? "text-primary" : "text-destructive"}`}>
              {row.rent}
            </td>
            <td className={`py-2.5 px-3 text-right font-mono text-xs ${row.breakeven === "harmful" ? "text-destructive" : "text-muted-foreground"}`}>
              {row.breakeven}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const BenchmarksSection = () => {
  const [tab, setTab] = useState<"write" | "read">("write");

  return (
    <section id="benchmarks" className="py-24 px-6 border-t border-border">
      <div className="max-w-5xl mx-auto">
        <p className="section-label">Benchmarks</p>
        <h2 className="text-3xl font-bold mb-4">Real numbers, not promises</h2>
        <p className="text-muted-foreground mb-8 max-w-lg">
          All benchmarks run on-chain with Anchor. Priority fee: 1,000 µL/CU.
        </p>

        <div className="flex gap-1 mb-6 p-1 bg-secondary rounded-lg w-fit">
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

        <motion.div
          key={tab}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="rounded-lg border border-border bg-card overflow-hidden"
        >
          <BenchmarkTable data={tab === "write" ? writeData : readData} type={tab} />
        </motion.div>

        <div className="mt-8 p-5 rounded-lg border border-border bg-card">
          <h3 className="font-semibold mb-2">Conclusion</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            For structured data, the rent saving is immediate and permanent. At zero priority fee — the default for most transactions — compression adds <strong className="text-foreground">no extra lamport cost whatsoever</strong>. The rent saving is pure profit. On real mainnet accounts, OpenBook v2 BookSide accounts compress 54× and save ~0.62 SOL each. The only case where it backfires is random or already-compressed data.
          </p>
          <div className="mt-4 p-3 rounded-md bg-secondary/50 border border-border">
            <p className="text-xs text-muted-foreground">
              <span className="text-primary font-mono">Note:</span> Rent is refunded when you close the account. If the account is short-lived,
              the rent saving evaporates. Compression makes the most sense for long-lived accounts.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
