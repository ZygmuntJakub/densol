import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressBench } from "../target/types/compress_bench";
import { ComputeBudgetProgram, Keypair, SystemProgram } from "@solana/web3.js";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const WRITE_SIZES = [256, 512, 800];
const READ_SIZES = [256, 512, 1024, 2048, 4096, 8192, 10240];
const CHUNK_SIZE = 800;
const MAX_CU = 1_400_000;
const PRIORITY_FEE_ULAMPORTS = 1_000;

// ── Data generators ─────────────────────────────────────────────────────────

function repetitive(size: number): Buffer {
  const pattern = Buffer.from(
    "Hello Solana! This is benchmark metadata for on-chain compression. "
  );
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = pattern[i % pattern.length];
  return out;
}

function jsonLike(size: number): Buffer {
  const pattern = Buffer.from(
    '{"name":"MyToken","symbol":"MTK","uri":"https://arweave.net/abc","seller_fee":500,"creators":[{"address":"So11111111111111111111111111111111111111112","share":100}]}'
  );
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = pattern[i % pattern.length];
  return out;
}

function pseudoRandom(size: number): Buffer {
  let s = 0xdeadbeef;
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const accountSpace = (n: number) => 8 + 4 + n;

async function createStore(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider
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
  return kp;
}

async function uploadChunked(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  store: Keypair,
  data: Buffer
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    await program.methods
      .storeRaw(chunk)
      .accounts({
        store: store.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
      .rpc();
  }
}

async function realTxCu(
  provider: anchor.AnchorProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any
): Promise<number | null> {
  const sig = await builder
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
    .rpc();
  await provider.connection.confirmTransaction(sig, "confirmed");
  const tx = await provider.connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  return tx?.meta?.computeUnitsConsumed ?? null;
}

async function simulateWithLogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any
): Promise<{ cu: number | null; logs: string[] }> {
  const result = await builder
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
    .simulate();
  const logs: string[] = result.raw;
  let cu: number | null = null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].match(/consumed (\d+) of \d+ compute units/);
    if (m) {
      cu = parseInt(m[1], 10);
      break;
    }
  }
  return { cu, logs };
}

function parseChecksum(logs: string[]): bigint | null {
  for (const log of logs) {
    const m = log.match(/checksum=(\d+)/);
    if (m) return BigInt(m[1]);
  }
  return null;
}

// ── Types ───────────────────────────────────────────────────────────────────

type WriteRow = {
  label: string;
  size: number;
  compSize: number;
  ratio: string;
  storeRawCu: number | null;
  storeCompCu: number | null;
  writeOverhead: number | null;
  rentSaving: number;
  breakEven: string;
};

type ReadRow = {
  label: string;
  size: number;
  compSize: number;
  ratio: string;
  readRawCu: number | null;
  readCompCu: number | null;
  readOverhead: number | null;
  rentSaving: number;
  breakEven: string;
};

// ── Benchmark suite ─────────────────────────────────────────────────────────

describe("compress_bench", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  const writeResults: WriteRow[] = [];
  const readResults: ReadRow[] = [];

  const datasets: Array<{ label: string; gen: (n: number) => Buffer }> = [
    { label: "repetitive", gen: repetitive },
    { label: "json-like", gen: jsonLike },
    { label: "random", gen: pseudoRandom },
  ];

  // ── Write benchmarks (tx-limited sizes) ─────────────────────────────────

  describe("WRITE (tx-limited)", () => {
    datasets.forEach(({ label, gen }) => {
      WRITE_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, async function () {
          this.timeout(120_000);
          const data = gen(size);

          const [rawStore, compStore, rentRaw] = await Promise.all([
            createStore(program, provider),
            createStore(program, provider),
            provider.connection.getMinimumBalanceForRentExemption(accountSpace(size)),
          ]);

          const storeRawCu = await realTxCu(
            provider,
            program.methods.storeRaw(data).accounts({
              store: rawStore.publicKey,
              payer: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
          );

          let storeCompCu: number | null = null;
          let compSize = size;
          let rentComp = rentRaw;

          try {
            storeCompCu = await realTxCu(
              provider,
              program.methods.storeCompressed(data).accounts({
                store: compStore.publicKey,
                payer: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
              })
            );

            const compAccount = await program.account.dataStore.fetch(
              compStore.publicKey
            );
            compSize = (compAccount.data as Buffer).length;
            rentComp =
              await provider.connection.getMinimumBalanceForRentExemption(
                accountSpace(compSize)
              );
          } catch (e: any) {
            const msg = e.message ?? "";
            const logs: string[] =
              e.logs ?? e.simulationResponse?.logs ?? [];
            if (
              msg.includes("out of memory") ||
              logs.some((l: string) => l.includes("out of memory"))
            ) {
              storeCompCu = null;
            } else {
              throw e;
            }
          }

          const rentSaving = rentRaw - rentComp;
          const ratio = (size / compSize).toFixed(2);
          const writeOverhead =
            storeRawCu !== null && storeCompCu !== null
              ? storeCompCu - storeRawCu
              : null;

          let breakEven: string;
          if (storeCompCu === null) {
            breakEven = "OOM";
          } else if (rentSaving <= 0) {
            breakEven = "harmful";
          } else if (writeOverhead !== null && writeOverhead <= 0) {
            breakEven = "always wins";
          } else if (writeOverhead !== null) {
            const writes = Math.round(
              (rentSaving * 1_000_000) / (writeOverhead * PRIORITY_FEE_ULAMPORTS)
            );
            breakEven = writes.toLocaleString("en");
          } else {
            breakEven = "N/A";
          }

          writeResults.push({
            label,
            size,
            compSize,
            ratio,
            storeRawCu,
            storeCompCu,
            writeOverhead,
            rentSaving,
            breakEven,
          });

          console.log(
            `  [${label}] ${size}B → ${compSize}B (${ratio}x)` +
              `  raw=${storeRawCu}  comp=${storeCompCu}` +
              `  overhead=${writeOverhead}` +
              `  rent${rentSaving >= 0 ? "+" : ""}${rentSaving}` +
              `  break-even=${breakEven}`
          );
        });
      });
    });
  });

  // ── Read benchmarks (account-limited sizes) ─────────────────────────────

  describe("READ (account-limited)", () => {
    datasets.forEach(({ label, gen }) => {
      READ_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, async function () {
          this.timeout(120_000);
          const data = gen(size);
          const expectedChecksum = BigInt(data.reduce((sum, b) => sum + b, 0));

          const [rawStore, compStore, rentRaw] = await Promise.all([
            createStore(program, provider),
            createStore(program, provider),
            provider.connection.getMinimumBalanceForRentExemption(accountSpace(size)),
          ]);

          await uploadChunked(program, provider, rawStore, data);
          await uploadChunked(program, provider, compStore, data);

          let compSize = size;
          let rentComp = rentRaw;
          let compressOom = false;

          try {
            await program.methods
              .compressStored()
              .accounts({
                store: compStore.publicKey,
                payer: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .preInstructions([
                ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
              ])
              .rpc();

            const compAccount = await program.account.dataStore.fetch(
              compStore.publicKey
            );
            compSize = (compAccount.data as Buffer).length;
            rentComp =
              await provider.connection.getMinimumBalanceForRentExemption(
                accountSpace(compSize)
              );
          } catch (e: any) {
            const msg = e.message ?? "";
            const logs: string[] =
              e.logs ?? e.simulationResponse?.logs ?? [];
            if (
              msg.includes("out of memory") ||
              logs.some((l: string) => l.includes("out of memory"))
            ) {
              compressOom = true;
            } else {
              throw e;
            }
          }

          const rawResult = await simulateWithLogs(
            program.methods
              .readRaw()
              .accounts({ store: rawStore.publicKey })
          );

          let compResult: { cu: number | null; logs: string[] } = {
            cu: null,
            logs: [],
          };
          if (!compressOom) {
            compResult = await simulateWithLogs(
              program.methods
                .readCompressed()
                .accounts({ store: compStore.publicKey })
            );
          }

          const rawChecksum = parseChecksum(rawResult.logs);
          assert.notStrictEqual(rawChecksum, null, "raw checksum missing");
          assert.strictEqual(rawChecksum, expectedChecksum, "raw checksum mismatch");

          if (!compressOom) {
            const compChecksum = parseChecksum(compResult.logs);
            assert.notStrictEqual(compChecksum, null, "compressed checksum missing");
            assert.strictEqual(
              compChecksum,
              expectedChecksum,
              "roundtrip checksum mismatch"
            );
          }

          const readRawCu = rawResult.cu;
          const readCompCu = compResult.cu;
          const readOverhead =
            readRawCu !== null && readCompCu !== null
              ? readCompCu - readRawCu
              : null;
          const rentSaving = rentRaw - rentComp;
          const ratio = (size / compSize).toFixed(2);

          let breakEven: string;
          if (compressOom) {
            breakEven = "OOM";
          } else if (rentSaving <= 0) {
            breakEven = "harmful";
          } else if (readOverhead !== null && readOverhead <= 0) {
            breakEven = "always wins";
          } else if (readOverhead !== null) {
            const reads = Math.round(
              (rentSaving * 1_000_000) / (readOverhead * PRIORITY_FEE_ULAMPORTS)
            );
            breakEven = reads.toLocaleString("en");
          } else {
            breakEven = "N/A";
          }

          readResults.push({
            label,
            size,
            compSize,
            ratio,
            readRawCu,
            readCompCu,
            readOverhead,
            rentSaving,
            breakEven,
          });

          console.log(
            `  [${label}] ${size}B → ${compSize}B (${ratio}x)` +
              `  rawRead=${readRawCu}  compRead=${readCompCu}` +
              `  overhead=${readOverhead}` +
              `  rent${rentSaving >= 0 ? "+" : ""}${rentSaving}` +
              `  break-even=${breakEven}`
          );
        });
      });
    });
  });

  // ── Output ──────────────────────────────────────────────────────────────

  after("print results", () => {
    const p = (v: string | number, w: number) => String(v).padStart(w);
    const fmt = (n: number | null) => (n !== null ? n.toLocaleString("en") : "OOM");

    // Write table
    {
      console.log("\n── WRITE BENCHMARK (tx-limited) ──\n");
      const cols = ["data-type", "size", "comp", "ratio", "store-raw CU", "store-comp CU", "overhead", "rent-saving", "break-even"];
      const W = [10, 5, 5, 6, 13, 14, 9, 12, 12];
      console.log(cols.map((c, i) => p(c, W[i])).join("  "));
      console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
      for (const r of writeResults) {
        console.log(
          [
            p(r.label, W[0]),
            p(r.size, W[1]),
            p(r.compSize, W[2]),
            p(r.ratio + "x", W[3]),
            p(fmt(r.storeRawCu), W[4]),
            p(fmt(r.storeCompCu), W[5]),
            p(fmt(r.writeOverhead), W[6]),
            p(r.rentSaving, W[7]),
            p(r.breakEven, W[8]),
          ].join("  ")
        );
      }
    }

    // Read table
    {
      console.log("\n── READ BENCHMARK (account-limited) ──\n");
      const cols = ["data-type", "size", "comp", "ratio", "read-raw CU", "read-comp CU", "overhead", "rent-saving", "break-even"];
      const W = [10, 6, 6, 6, 12, 13, 9, 12, 12];
      console.log(cols.map((c, i) => p(c, W[i])).join("  "));
      console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
      let lastLabel = "";
      for (const r of readResults) {
        if (r.label !== lastLabel && lastLabel !== "") {
          console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
        }
        lastLabel = r.label;
        console.log(
          [
            p(r.label, W[0]),
            p(r.size, W[1]),
            p(r.compSize, W[2]),
            p(r.ratio + "x", W[3]),
            p(fmt(r.readRawCu), W[4]),
            p(fmt(r.readCompCu), W[5]),
            p(fmt(r.readOverhead), W[6]),
            p(r.rentSaving, W[7]),
            p(r.breakEven, W[8]),
          ].join("  ")
        );
      }
    }

    // JSON output
    const outDir = path.resolve(__dirname, "..", "results");
    fs.mkdirSync(outDir, { recursive: true });
    const json = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        config: { priorityFeeUlamports: PRIORITY_FEE_ULAMPORTS },
        write: writeResults,
        read: readResults,
      },
      null,
      2
    );
    const outPath = path.join(outDir, "benchmark.json");
    fs.writeFileSync(outPath, json);
    console.log(`\nResults written to ${outPath}`);
  });
});
