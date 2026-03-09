import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressBench } from "../target/types/compress_bench";
import { ComputeBudgetProgram, Keypair, SystemProgram } from "@solana/web3.js";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Config ─────────────────────────────────────────────────────────────────────

const SIZES = [256, 512, 1024, 2048, 4096, 8192, 10240];
const CHUNK_SIZE = 800;
const MAX_CU = 1_400_000;
const PRIORITY_FEE_ULAMPORTS = 1_000; // µlamports/CU — break-even reference

// ── Data generators ────────────────────────────────────────────────────────────

/** Highly repetitive ASCII — best-case compression (~80x). */
function repetitive(size: number): Buffer {
  const pattern = Buffer.from(
    "Hello Solana! This is benchmark metadata for on-chain compression. "
  );
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = pattern[i % pattern.length];
  return out;
}

/** JSON-like structured data — realistic NFT metadata (~2–55x). */
function jsonLike(size: number): Buffer {
  const pattern = Buffer.from(
    '{"name":"MyToken","symbol":"MTK","uri":"https://arweave.net/abc","seller_fee":500,"creators":[{"address":"So11111111111111111111111111111111111111112","share":100}]}'
  );
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = pattern[i % pattern.length];
  return out;
}

/** LCG pseudo-random bytes — worst-case, incompressible (~1x). */
function pseudoRandom(size: number): Buffer {
  let s = 0xdeadbeef;
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

// ── Account helpers ────────────────────────────────────────────────────────────

async function setupStore(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  payload: Buffer
): Promise<Keypair> {
  const kp = Keypair.generate();

  await program.methods
    .initStore()
    .accounts({
      store: kp.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([kp])
    .rpc();

  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    const chunk = payload.slice(offset, Math.min(offset + CHUNK_SIZE, payload.length));
    await program.methods
      .appendChunk(chunk)
      .accounts({
        store: kp.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  return kp;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function simulateWithLogs(builder: any): Promise<{ cu: number | null; logs: string[] }> {
  const result = await builder
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
    .simulate();
  const logs: string[] = result.raw;
  let cu: number | null = null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/consumed (\d+) of \d+ compute units/);
    if (m) { cu = parseInt(m[1], 10); break; }
  }
  return { cu, logs };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function simulateCu(builder: any): Promise<number | null> {
  return (await simulateWithLogs(builder)).cu;
}

function parseChecksum(logs: string[]): bigint | null {
  for (const log of logs) {
    const m = log.match(/checksum=(\d+)/);
    if (m) return BigInt(m[1]);
  }
  return null;
}

const accountSpace = (n: number) => 8 + 4 + n; // disc + Borsh Vec prefix + data

// ── Benchmark suite ────────────────────────────────────────────────────────────

describe("compress_bench", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  type Row = {
    label: string;
    size: number;
    compSize: number;
    ratio: string;
    // Total CU (Borsh overhead included)
    borshRawCu: number | null;    // deser(N) — raw account floor
    borshCompCu: number | null;   // deser(M) — compressed account floor
    rawCu: number | null;         // Case A read:  borsh(N) + checksum(N)
    writeCompCu: number | null;   // Case B write: borsh(N) + compress(N→M) + realloc
    decompCu: number | null;      // Case B read:  borsh(M) + decompress(M→N) + checksum(N)
    // Net CU (Borsh overhead subtracted — algorithm cost only)
    netRawCu: number | null;      // checksum(N)
    netWriteCompCu: number | null;// compress(N→M) + realloc overhead
    netDecompCu: number | null;   // decompress(M→N) + checksum(N)
    rentSavings: number;
    breakEven: string;
  };
  const results: Row[] = [];

  const datasets: Array<{ label: string; gen: (n: number) => Buffer }> = [
    { label: "repetitive", gen: repetitive  },
    { label: "json-like",  gen: jsonLike    },
    { label: "random",     gen: pseudoRandom },
  ];

  datasets.forEach(({ label, gen }) => {
    SIZES.forEach((size) => {
      it(`[${label}] ${size}B`, async function () {
        this.timeout(120_000);

        const raw = gen(size);

        // ── Phase 1: setup both stores + raw rent in parallel ────────────
        // rawStore  → stays raw for Case A (no compression)
        // compStore → will be compressed on-chain for Case B
        const [rawStore, compStore, rentRaw] = await Promise.all([
          setupStore(program, provider, raw),
          setupStore(program, provider, raw),
          provider.connection.getMinimumBalanceForRentExemption(accountSpace(size)),
        ]);

        // ── Phase 2: compress compStore on-chain + measure real write CU ─
        // Using .rpc() + getTransaction() instead of .simulate() because
        // Anchor simulation is unreliable for realloc on large accounts (≥8KB).
        let writeCompCu: number | null = null;
        let compSize = size;
        let rentComp = rentRaw;
        let compressOom = false;

        try {
          const compressSig = await program.methods
            .compressStored()
            .accounts({
              store: compStore.publicKey,
              payer: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
            .rpc();

          await provider.connection.confirmTransaction(compressSig, "confirmed");
          const compressTx = await provider.connection.getTransaction(compressSig, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          writeCompCu = compressTx?.meta?.computeUnitsConsumed ?? null;

          const compAccount = await program.account.dataStore.fetch(compStore.publicKey);
          compSize = (compAccount.data as Buffer).length;
          rentComp = await provider.connection.getMinimumBalanceForRentExemption(
            accountSpace(compSize)
          );
        } catch (e: any) {
          const msg = e.message ?? "";
          const logs: string[] = e.logs ?? e.simulationResponse?.logs ?? [];
          if (msg.includes("out of memory") || logs.some((l: string) => l.includes("out of memory"))) {
            compressOom = true;
          } else {
            throw e;
          }
        }

        // ── Phase 5: all read simulations in parallel ─────────────────────
        const rawResult = await simulateWithLogs(
          program.methods.benchmarkRaw().accounts({ store: rawStore.publicKey })
        );
        const borshRawCu = await simulateCu(
          program.methods.benchmarkBorsh().accounts({ store: rawStore.publicKey })
        );

        let decompResult: { cu: number | null; logs: string[] } = { cu: null, logs: [] };
        let borshCompCu: number | null = null;
        if (!compressOom) {
          [decompResult, borshCompCu] = await Promise.all([
            simulateWithLogs(program.methods.benchmarkDecompress().accounts({ store: compStore.publicKey })),
            simulateCu(program.methods.benchmarkBorsh().accounts({ store: compStore.publicKey })),
          ]);
        }

        const rawCu = rawResult.cu;
        const decompCu = decompResult.cu;

        // ── Correctness: verify compress→decompress roundtrip ─────────────
        const expectedChecksum = BigInt(raw.reduce((sum, b) => sum + b, 0));
        const rawChecksum = parseChecksum(rawResult.logs);
        assert.notStrictEqual(rawChecksum, null, "raw checksum not found in logs");
        assert.strictEqual(rawChecksum, expectedChecksum,
          `raw checksum mismatch: expected ${expectedChecksum}, got ${rawChecksum}`);

        if (!compressOom) {
          const decompChecksum = parseChecksum(decompResult.logs);
          assert.notStrictEqual(decompChecksum, null, "decompress checksum not found in logs");
          assert.strictEqual(decompChecksum, expectedChecksum,
            `roundtrip failed: expected checksum ${expectedChecksum}, got ${decompChecksum}`);
        }

        // ── Net costs: algorithm CU with Borsh overhead subtracted ────────
        const netRawCu       = rawCu       !== null && borshRawCu  !== null ? rawCu       - borshRawCu  : null;
        const netWriteCompCu = writeCompCu !== null && borshRawCu  !== null ? writeCompCu - borshRawCu  : null;
        const netDecompCu    = decompCu    !== null && borshCompCu !== null ? decompCu    - borshCompCu : null;

        // ── Break-even: reads until rent saving > per-read CU overhead ────
        // readOverhead = extra CU per read when using compression (decomp vs raw).
        // writeOverhead is a one-time cost (sunk on first write).
        const readOverhead = rawCu !== null && decompCu !== null ? decompCu - rawCu : null;
        const rentSavings  = rentRaw - rentComp;

        let breakEven: string;
        if (compressOom) {
          breakEven = "OOM";
        } else if (rentSavings <= 0) {
          breakEven = "harmful";
        } else if (readOverhead !== null && readOverhead <= 0) {
          breakEven = "always wins";
        } else if (readOverhead !== null) {
          const reads = Math.round(
            (rentSavings * 1_000_000) / (readOverhead * PRIORITY_FEE_ULAMPORTS)
          );
          breakEven = reads.toLocaleString("en");
        } else {
          breakEven = "N/A";
        }

        results.push({
          label, size, compSize, ratio: (size / compSize).toFixed(2),
          borshRawCu, borshCompCu, rawCu, writeCompCu, decompCu,
          netRawCu, netWriteCompCu, netDecompCu,
          rentSavings, breakEven,
        });

        console.log(
          `  [${label}] ${size}B → ${compSize}B(${(size / compSize).toFixed(1)}x)` +
          `  borsh=${borshRawCu}  rawCU=${rawCu}  writeCU=${writeCompCu}  decompCU=${decompCu}` +
          `  netWrite=${netWriteCompCu}  netDecomp=${netDecompCu}` +
          `  rent${rentSavings >= 0 ? "+" : ""}${rentSavings}L  break-even=${breakEven}`
        );
      });
    });
  });

  after("print summary table", () => {
    const p = (v: string | number, w: number) => String(v).padStart(w);

    // Table 1: total CU (includes Borsh overhead)
    {
      const W = [10, 6, 6, 6, 9, 9, 13, 9, 11, 20];
      const cols = ["data-type", "orig", "comp", "ratio", "borsh CU", "raw CU", "write+comp CU", "decomp CU", "rent+save", `break-even@${PRIORITY_FEE_ULAMPORTS}µL`];
      const sep = "─".repeat(W.reduce((a, b) => a + b + 2, 0));

      console.log("\n" + sep);
      console.log("  Total CU — Case A: raw read  |  Case B: on-chain compress write + decompress read");
      console.log(sep);
      console.log("  " + cols.map((c, i) => p(c, W[i])).join("  "));
      console.log(sep);

      let lastLabel = "";
      for (const r of results) {
        if (r.label !== lastLabel && lastLabel !== "") console.log(sep);
        lastLabel = r.label;
        console.log("  " + [
          p(r.label, W[0]), p(r.size, W[1]), p(r.compSize, W[2]),
          p(r.ratio + "x", W[3]),
          p(r.borshRawCu ?? "N/A", W[4]),
          p(r.rawCu ?? "N/A", W[5]),
          p(r.writeCompCu ?? "N/A", W[6]),
          p(r.decompCu ?? "N/A", W[7]),
          p(r.rentSavings, W[8]), p(r.breakEven, W[9]),
        ].join("  "));
      }
      console.log(sep);
    }

    // Table 2: net CU (Borsh subtracted — algorithm cost only)
    {
      const W = [10, 6, 6, 6, 9, 14, 11, 11, 20];
      const cols = ["data-type", "orig", "comp", "ratio", "net cksum", "net write+comp", "net decomp", "rent+save", `break-even@${PRIORITY_FEE_ULAMPORTS}µL`];
      const sep = "─".repeat(W.reduce((a, b) => a + b + 2, 0));

      console.log("\n" + sep);
      console.log("  Net algorithm CU (Borsh overhead SUBTRACTED — pure algorithm cost)");
      console.log(sep);
      console.log("  " + cols.map((c, i) => p(c, W[i])).join("  "));
      console.log(sep);

      let lastLabel = "";
      for (const r of results) {
        if (r.label !== lastLabel && lastLabel !== "") console.log(sep);
        lastLabel = r.label;
        console.log("  " + [
          p(r.label, W[0]), p(r.size, W[1]), p(r.compSize, W[2]),
          p(r.ratio + "x", W[3]),
          p(r.netRawCu ?? "N/A", W[4]),
          p(r.netWriteCompCu ?? "N/A", W[5]),
          p(r.netDecompCu ?? "N/A", W[6]),
          p(r.rentSavings, W[7]), p(r.breakEven, W[8]),
        ].join("  "));
      }
      console.log(sep + "\n");
    }

    // ── Write results to JSON ─────────────────────────────────────────
    const strategy = process.env.BENCH_STRATEGY || "lz4";
    const outDir = path.resolve(__dirname, "..", "results");
    fs.mkdirSync(outDir, { recursive: true });

    const json = JSON.stringify({
      strategy,
      timestamp: new Date().toISOString(),
      config: { priorityFeeUlamports: PRIORITY_FEE_ULAMPORTS },
      rows: results,
    }, null, 2);

    const outPath = path.join(outDir, `benchmark-${strategy}.json`);
    fs.writeFileSync(outPath, json);
    console.log(`Results written to ${outPath}`);
  });
});
