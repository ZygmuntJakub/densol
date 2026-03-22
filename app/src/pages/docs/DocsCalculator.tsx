import { DocsPage, H2, P } from "@/components/docs/DocsComponents";
import { useState, useMemo } from "react";
import { motion } from "framer-motion";

const LAMPORTS_PER_BYTE = 6960;
const RENT_EXEMPT_BASE = 890880;
const COMPRESSION_RATIOS: Record<string, number> = {
  repetitive: 0.15, "json-like": 0.55, "token-metadata": 0.45, "game-state": 0.35, custom: 0.5,
};
const OVERHEAD_CU_PER_BYTE = 12;

const DocsCalculator = () => {
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
    const cuCostPerWrite = (overheadCU * priorityFee) / 1_000_000;
    const totalWrites = writesPerDay * accountLifeDays;
    const totalCuCost = cuCostPerWrite * totalWrites;
    const netSaving = rentSaving - totalCuCost;
    const compressionRatio = dataSize / compressedSize;
    const breakevenWrites = cuCostPerWrite > 0 ? Math.ceil(rentSaving / cuCostPerWrite) : Infinity;
    return { compressedSize, rentRaw, rentCompressed, rentSaving, overheadCU, totalCuCost, netSaving, compressionRatio, breakevenWrites, totalWrites, worthIt: netSaving > 0 };
  }, [dataType, dataSize, priorityFee, writesPerDay, accountLifeDays]);

  return (
    <DocsPage
      title="Break-Even Calculator"
      description="Determine if compression is worth it for your specific use case."
    >
      <H2>Configuration</H2>
      <P>Adjust the parameters below to match your use case.</P>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-6">
        <div className="space-y-5">
          <Field label="Data Type">
            <select value={dataType} onChange={(e) => setDataType(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="repetitive">Repetitive (best case)</option>
              <option value="json-like">JSON-like / Structured</option>
              <option value="token-metadata">Token Metadata</option>
              <option value="game-state">Game State</option>
              <option value="custom">Custom (~50% ratio)</option>
            </select>
          </Field>
          <Slider label="Data Size" value={dataSize} unit="B" min={64} max={10240} step={64} onChange={setDataSize} />
          <Slider label="Priority Fee" value={priorityFee} unit="µL/CU" min={100} max={10000} step={100} onChange={setPriorityFee} />
          <Slider label="Writes per day" value={writesPerDay} min={1} max={1000} step={1} onChange={setWritesPerDay} />
          <Slider label="Account lifetime" value={accountLifeDays} unit="days" min={1} max={1825} step={1} onChange={setAccountLifeDays} />
        </div>

        <motion.div key={`${dataType}-${dataSize}-${priorityFee}-${writesPerDay}-${accountLifeDays}`}
          initial={{ opacity: 0.7 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="space-y-4">
          <div className={`rounded-lg border-2 p-6 text-center ${result.worthIt ? "border-primary/40 bg-primary/5" : "border-destructive/40 bg-destructive/5"}`}>
            <p className="text-sm text-muted-foreground mb-1">Verdict</p>
            <p className={`text-3xl font-bold ${result.worthIt ? "text-primary" : "text-destructive"}`}>
              {result.worthIt ? "Yes, compress!" : "Not worth it"}
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Net saving: <span className="font-mono font-semibold text-foreground">{(result.netSaving / 1_000_000).toFixed(3)} SOL</span>
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
    </DocsPage>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <label className="text-sm font-medium text-foreground block mb-2">{label}</label>
    {children}
  </div>
);

const Slider = ({ label, value, unit, min, max, step, onChange }: {
  label: string; value: number; unit?: string; min: number; max: number; step: number; onChange: (v: number) => void;
}) => (
  <div>
    <label className="text-sm font-medium text-foreground block mb-2">
      {label}: <span className="text-primary font-mono">{value}{unit ? ` ${unit}` : ""}</span>
    </label>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" />
    <div className="flex justify-between text-xs text-muted-foreground mt-1">
      <span>{min}{unit ? ` ${unit}` : ""}</span><span>{max}{unit ? ` ${unit}` : ""}</span>
    </div>
  </div>
);

const Row = ({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) => (
  <div className="flex justify-between items-center text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className={`font-mono ${highlight ? "text-primary font-semibold" : "text-foreground"}`}>{value}</span>
  </div>
);

export default DocsCalculator;
