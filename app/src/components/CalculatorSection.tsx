import { useState, useMemo } from "react";
import { motion } from "framer-motion";

const LAMPORTS_PER_BYTE = 6960;
const RENT_EXEMPT_BASE = 890880;

// Approximate compression ratios based on benchmarks
const COMPRESSION_RATIOS: Record<string, number> = {
  "repetitive": 0.15,
  "json-like": 0.55,
  "token-metadata": 0.45,
  "game-state": 0.35,
  "custom": 0.5,
};

const OVERHEAD_CU_PER_BYTE = 12; // approximate from benchmarks

export const CalculatorSection = () => {
  const [dataType, setDataType] = useState("json-like");
  const [dataSize, setDataSize] = useState(512);
  const [priorityFee, setPriorityFee] = useState(1000);
  const [writesPerDay, setWritesPerDay] = useState(10);
  const [accountLifeDays, setAccountLifeDays] = useState(365);

  const result = useMemo(() => {
    const ratio = COMPRESSION_RATIOS[dataType] || 0.5;
    const compressedSize = Math.ceil(dataSize * ratio);
    const rentRaw = RENT_EXEMPT_BASE + dataSize * LAMPORTS_PER_BYTE;
    const rentCompressed = RENT_EXEMPT_BASE + compressedSize * LAMPORTS_PER_BYTE;
    const rentSaving = rentRaw - rentCompressed;
    const overheadCU = dataSize * OVERHEAD_CU_PER_BYTE;
    const cuCostPerWrite = (overheadCU * priorityFee) / 1_000_000; // in lamports
    const totalWrites = writesPerDay * accountLifeDays;
    const totalCuCost = cuCostPerWrite * totalWrites;
    const netSaving = rentSaving - totalCuCost;
    const compressionRatio = dataSize / compressedSize;
    const breakevenWrites = cuCostPerWrite > 0 ? Math.ceil(rentSaving / cuCostPerWrite) : Infinity;

    return {
      compressedSize,
      rentRaw,
      rentCompressed,
      rentSaving,
      overheadCU,
      totalCuCost,
      netSaving,
      compressionRatio,
      breakevenWrites,
      totalWrites,
      worthIt: netSaving > 0,
    };
  }, [dataType, dataSize, priorityFee, writesPerDay, accountLifeDays]);

  return (
    <section id="calculator" className="py-24 px-6 border-t border-border">
      <div className="max-w-3xl mx-auto">
        <p className="section-label">Calculator</p>
        <h2 className="text-3xl font-bold mb-4">Is compression worth it?</h2>
        <p className="text-muted-foreground mb-10">
          Input your data profile and see whether densol saves you money.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-5">
            <div>
              <label className="text-sm font-medium text-foreground block mb-2">Data Type</label>
              <select
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="repetitive">Repetitive (best case)</option>
                <option value="json-like">JSON-like / Structured</option>
                <option value="token-metadata">Token Metadata</option>
                <option value="game-state">Game State</option>
                <option value="custom">Custom (~50% ratio)</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-2">
                Data Size: <span className="text-primary font-mono">{dataSize} B</span>
              </label>
              <input
                type="range"
                min={64}
                max={10240}
                step={64}
                value={dataSize}
                onChange={(e) => setDataSize(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>64 B</span><span>10 KB</span>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-2">
                Priority Fee: <span className="text-primary font-mono">{priorityFee} µL/CU</span>
              </label>
              <input
                type="range"
                min={100}
                max={10000}
                step={100}
                value={priorityFee}
                onChange={(e) => setPriorityFee(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>100</span><span>10,000</span>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-2">
                Writes per day: <span className="text-primary font-mono">{writesPerDay}</span>
              </label>
              <input
                type="range"
                min={1}
                max={1000}
                step={1}
                value={writesPerDay}
                onChange={(e) => setWritesPerDay(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>1</span><span>1,000</span>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-2">
                Account lifetime: <span className="text-primary font-mono">{accountLifeDays} days</span>
              </label>
              <input
                type="range"
                min={1}
                max={1825}
                step={1}
                value={accountLifeDays}
                onChange={(e) => setAccountLifeDays(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>1 day</span><span>5 years</span>
              </div>
            </div>
          </div>

          <motion.div
            key={`${dataType}-${dataSize}-${priorityFee}-${writesPerDay}-${accountLifeDays}`}
            initial={{ opacity: 0.7 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="space-y-4"
          >
            <div className={`rounded-lg border-2 p-6 text-center ${result.worthIt ? "border-primary/40 bg-primary/5" : "border-destructive/40 bg-destructive/5"}`}>
              <p className="text-sm text-muted-foreground mb-1">Verdict</p>
              <p className={`text-3xl font-bold ${result.worthIt ? "text-primary" : "text-destructive"}`}>
                {result.worthIt ? "Yes, compress!" : "Not worth it"}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Net saving: <span className="font-mono font-semibold text-foreground">
                  {(result.netSaving / 1_000_000).toFixed(3)} SOL
                </span>
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              <Row label="Compression ratio" value={`${result.compressionRatio.toFixed(1)}x`} />
              <Row label="Compressed size" value={`${result.compressedSize} B`} />
              <Row label="Rent (raw)" value={`${(result.rentRaw / 1_000_000).toFixed(4)} SOL`} />
              <Row label="Rent (compressed)" value={`${(result.rentCompressed / 1_000_000).toFixed(4)} SOL`} />
              <Row label="Rent saved" value={`${(result.rentSaving / 1_000_000).toFixed(4)} SOL`} highlight />
              <div className="border-t border-border pt-3">
                <Row label="CU overhead / write" value={`${result.overheadCU.toLocaleString()} CU`} />
                <Row label="Total writes" value={result.totalWrites.toLocaleString()} />
                <Row label="Total CU cost" value={`${(result.totalCuCost / 1_000_000).toFixed(4)} SOL`} />
              </div>
              <div className="border-t border-border pt-3">
                <Row label="Break-even writes" value={result.breakevenWrites === Infinity ? "∞" : result.breakevenWrites.toLocaleString()} />
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

const Row = ({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) => (
  <div className="flex justify-between items-center text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className={`font-mono ${highlight ? "text-primary font-semibold" : "text-foreground"}`}>{value}</span>
  </div>
);
