import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressBench } from "../target/types/compress_bench";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const WRITE_SIZES = [256, 512, 800];
const READ_SIZES = [256, 512, 1024, 2048, 4096, 8192, 10240];
const CHUNK_SIZE = 900;
const MAX_CU = 1_400_000;
const PRIORITY_FEE_ULAMPORTS = 1_000;

// Set SKIP_SLOW=1 to skip the heap-ceiling probe and large-account demo.
// Useful when iterating on regular benchmark changes (saves ~2 min).
const SKIP_SLOW = process.env.SKIP_SLOW === "1";

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

function orderbook(size: number): Buffer {
  // 80-byte entry: 8B price f64 LE + 8B qty f64 LE + 1B side + 63B zeros
  const entry = Buffer.alloc(80);
  entry.writeDoubleLE(1234.5678, 0); // price
  entry.writeDoubleLE(100.0, 8); // quantity
  entry[16] = 0x01; // side: bid; bytes 17-79 already zero
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = entry[i % 80];
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

/**
 * Fund a fresh keypair via localnet airdrop so it can be used as a dedicated
 * fee-payer for a single upload stream.  Using one payer per stream removes the
 * shared provider.wallet write-lock that would otherwise force the validator to
 * process all transactions sequentially, even inside a Promise.all.
 */
async function fundedPayer(
  connection: anchor.web3.Connection
): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

/**
 * Build, sign, and send one transaction using a dedicated keypair as the fee
 * payer — provider.wallet is NOT involved.  Retries up to 3 times on blockhash
 * expiry; propagates any other error immediately.
 */
async function sendTxWithPayer(
  connection: anchor.web3.Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  payer: Keypair
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const tx: anchor.web3.Transaction = await builder.transaction();
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const result = await connection.confirmTransaction(
        { signature: sig, ...latestBlockhash },
        "confirmed"
      );
      if (result.value.err) {
        // Fetch on-chain logs so OOM detection works regardless of whether
        // preflight caught the failure first.
        const txInfo = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        const err = new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
        (err as any).logs = txInfo?.meta?.logMessages ?? [];
        throw err;
      }
      return sig;
    } catch (e: any) {
      const isExpiry =
        e.name === "TransactionExpiredBlockheightExceededError" ||
        (e.message ?? "").includes("Blockhash not found");
      if (attempt < 3 && isExpiry) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

async function uploadChunked(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  store: Keypair,
  data: Buffer,
  payer?: Keypair
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    const payerKey = payer?.publicKey ?? provider.wallet.publicKey;
    const builder = program.methods
      .storeRaw(chunk)
      .accounts({
        store: store.publicKey,
        payer: payerKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
    if (payer) {
      await sendTxWithPayer(provider.connection, builder, payer);
    } else {
      await withBlockhashRetry(() => builder.rpc());
    }
  }
}

async function uploadLarge(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  store: Keypair,
  data: Buffer,
  payer?: Keypair
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    const payerKey = payer?.publicKey ?? provider.wallet.publicKey;
    const builder = program.methods
      .appendRawLarge(chunk)
      .accounts({
        store: store.publicKey,
        payer: payerKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
    if (payer) {
      await sendTxWithPayer(provider.connection, builder, payer);
    } else {
      await withBlockhashRetry(() => builder.rpc());
    }
  }
}

/**
 * Like realTxCu but uses a dedicated keypair as fee-payer instead of
 * provider.wallet — allows concurrent WRITE measurements without nonce
 * contention on the shared wallet.  Caller must set .accounts({ payer:
 * payer.publicKey, ... }) on the builder before passing it in.
 */
async function realTxCuWithPayer(
  connection: anchor.web3.Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  payer: Keypair
): Promise<number | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const tx: anchor.web3.Transaction = await builder
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
        ])
        .transaction();
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const result = await connection.confirmTransaction(
        { signature: sig, ...latestBlockhash },
        "confirmed"
      );
      if (result.value.err)
        throw new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
      const receipt = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      return receipt?.meta?.computeUnitsConsumed ?? null;
    } catch (e: any) {
      const isExpiry =
        e.name === "TransactionExpiredBlockheightExceededError" ||
        (e.message ?? "").includes("Blockhash not found");
      if (attempt < 3 && isExpiry) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

async function simulateWithLogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any
): Promise<{ cu: number | null; logs: string[] }> {
  const result = await builder
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
    ])
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

/** Retry fn on transient "Blockhash not found" errors (max 3 attempts). */
async function withBlockhashRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg: string = e.message ?? "";
      if (attempt < 3 && msg.includes("Blockhash not found")) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
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

type ChunkedWriteRow = {
  label: string;
  size: number;
  compSize: number;
  ratio: string;
  storeRawCu: number | null;
  storeChunkedCu: number | null;
  overhead: number | null;
  rentSaving: number;
  breakEven: string;
};

type ChunkedReadFullRow = {
  label: string;
  size: number;
  compSize: number;
  ratio: string;
  readRawCu: number | null;
  readChunkedFullCu: number | null;
  overhead: number | null;
  rentSaving: number;
  breakEven: string;
};

type ChunkedReadChunkRow = {
  label: string;
  size: number;
  compSize: number;
  chunkCount: number;
  chunkIdx: number;
  rawCu: number | null;
  chunkCu: number | null;
  overhead: number | null;
};

type LargeAccountResult = {
  rawSize: number;
  compSize: number;
  chunkCount: number;
  compCu: number | null;
  chunkCu: number | null;
};

type CeilingRow = {
  path: "account" | "accountinfo";
  size: number;
  success: boolean;
  compSize: number | null;
};

/** Pre-populated fixture for READ benchmark tests.
 *  rawStore holds raw bytes; compStore holds compressed bytes (or raw if OOM).
 *  Created in before() hooks so all uploads run in parallel across accounts. */
type ReadFixture = {
  rawStore: Keypair;
  compStore: Keypair;
  compressOom: boolean;
  expectedChecksum: bigint;
  compSize: number;
  rentRaw: number;
  rentComp: number;
};

// ── Benchmark suite ─────────────────────────────────────────────────────────

describe("compress_bench", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  const writeResults: WriteRow[] = [];
  const readResults: ReadRow[] = [];
  const chunkedWriteResults: ChunkedWriteRow[] = [];
  const chunkedReadFullResults: ChunkedReadFullRow[] = [];
  const chunkedReadChunkResults: ChunkedReadChunkRow[] = [];
  let largeAccountResult: LargeAccountResult | null = null;
  const ceilingResults: CeilingRow[] = [];

  // Pre-populated fixtures for READ benchmarks.
  // Keyed by `${label}-${size}`. Filled by before() hooks so that
  // all account uploads happen in parallel across independent accounts,
  // cutting upload time from O(sum_of_chunks) to O(max_chunks).
  const readLzFixtures = new Map<string, ReadFixture>();
  const readChunkedFixtures = new Map<string, ReadFixture>();

  const datasets: Array<{ label: string; gen: (n: number) => Buffer }> = [
    { label: "repetitive", gen: repetitive },
    { label: "json-like", gen: jsonLike },
    { label: "random", gen: pseudoRandom },
    { label: "orderbook", gen: orderbook },
  ];

  // ── Shared READ fixture setup ─────────────────────────────────────────────
  //
  // Creates one rawStore + one lzCompStore + one chunkedCompStore per (label×size).
  // Raw data is uploaded ONCE to rawStore and shared between both READ suites,
  // eliminating the duplicate upload work the two previous inner before() hooks
  // performed.  All 28 (label×size) fixtures run concurrently; within each,
  // three upload streams run concurrently using dedicated payers.

  before(async function () {
    this.timeout(300_000);
    await Promise.all(
      datasets.flatMap(({ label, gen }) =>
        READ_SIZES.map(async (size) => {
          const data = gen(size);
          const expectedChecksum = BigInt(data.reduce((s, b) => s + b, 0));
          const [rawStore, lzCompStore, chunkedCompStore,
                 rawPayer, lzPayer, chunkedPayer, rentRaw] =
            await Promise.all([
              createStore(program, provider),
              createStore(program, provider),
              createStore(program, provider),
              fundedPayer(provider.connection),
              fundedPayer(provider.connection),
              fundedPayer(provider.connection),
              provider.connection.getMinimumBalanceForRentExemption(
                accountSpace(size)
              ),
            ]);

          // Upload raw data once + both to-be-compressed stores concurrently.
          await Promise.all([
            uploadChunked(program, provider, rawStore, data, rawPayer),
            uploadChunked(program, provider, lzCompStore, data, lzPayer),
            uploadChunked(program, provider, chunkedCompStore, data, chunkedPayer),
          ]);

          // Compress both stores concurrently; reuse upload payers (no extra airdrop).
          const [lzResult, chunkedResult] = await Promise.all([
            (async () => {
              let compressOom = false;
              let compSize = size;
              let rentComp = rentRaw;
              try {
                await sendTxWithPayer(
                  provider.connection,
                  program.methods
                    .compressStored()
                    .accounts({
                      store: lzCompStore.publicKey,
                      payer: lzPayer.publicKey,
                      systemProgram: SystemProgram.programId,
                    })
                    .preInstructions([
                      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
                    ]),
                  lzPayer
                );
                const acc = await program.account.dataStore.fetch(
                  lzCompStore.publicKey
                );
                compSize = (acc.data as Buffer).length;
                rentComp =
                  await provider.connection.getMinimumBalanceForRentExemption(
                    accountSpace(compSize)
                  );
              } catch (e: any) {
                const msg = e.message ?? "";
                const logs: string[] = [
                  ...(Array.isArray(e.logs) ? e.logs : []),
                  ...(Array.isArray(e.simulationResponse?.logs)
                    ? e.simulationResponse.logs
                    : []),
                ];
                if (
                  msg.includes("out of memory") ||
                  logs.some((l: string) => l.includes("out of memory"))
                ) {
                  compressOom = true;
                } else {
                  throw e;
                }
              }
              return { compressOom, compSize, rentComp };
            })(),
            (async () => {
              let compressOom = false;
              let compSize = size;
              let rentComp = rentRaw;
              try {
                await sendTxWithPayer(
                  provider.connection,
                  program.methods
                    .compressStoredChunked()
                    .accounts({
                      store: chunkedCompStore.publicKey,
                      payer: chunkedPayer.publicKey,
                      systemProgram: SystemProgram.programId,
                    })
                    .preInstructions([
                      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
                    ]),
                  chunkedPayer
                );
                const acc = await program.account.dataStore.fetch(
                  chunkedCompStore.publicKey
                );
                compSize = (acc.data as Buffer).length;
                rentComp =
                  await provider.connection.getMinimumBalanceForRentExemption(
                    accountSpace(compSize)
                  );
              } catch (e: any) {
                const msg = e.message ?? "";
                const logs: string[] = [
                  ...(Array.isArray(e.logs) ? e.logs : []),
                  ...(Array.isArray(e.simulationResponse?.logs)
                    ? e.simulationResponse.logs
                    : []),
                ];
                if (
                  msg.includes("out of memory") ||
                  logs.some((l: string) => l.includes("out of memory"))
                ) {
                  compressOom = true;
                } else {
                  throw e;
                }
              }
              return { compressOom, compSize, rentComp };
            })(),
          ]);

          // rawStore is shared between both READ suites — raw data uploaded once.
          readLzFixtures.set(`${label}-${size}`, {
            rawStore,
            compStore: lzCompStore,
            compressOom: lzResult.compressOom,
            expectedChecksum,
            compSize: lzResult.compSize,
            rentRaw,
            rentComp: lzResult.rentComp,
          });
          readChunkedFixtures.set(`${label}-${size}`, {
            rawStore,
            compStore: chunkedCompStore,
            compressOom: chunkedResult.compressOom,
            expectedChecksum,
            compSize: chunkedResult.compSize,
            rentRaw,
            rentComp: chunkedResult.rentComp,
          });
        })
      )
    );
  });

  // ── Write benchmarks (tx-limited sizes) ─────────────────────────────────

  describe("WRITE (tx-limited)", () => {
    // All 12 (label×size) fixtures measured concurrently in before().
    // Within each fixture, storeRaw and storeCompressed also run concurrently —
    // they use independent stores and independent dedicated payers.
    const writeFixtures = new Map<string, WriteRow>();

    before(async function () {
      this.timeout(120_000);
      await Promise.all(
        datasets.flatMap(({ label, gen }) =>
          WRITE_SIZES.map(async (size) => {
            const data = gen(size);
            const [rawStore, compStore, rawPayer, compPayer, rentRaw] =
              await Promise.all([
                createStore(program, provider),
                createStore(program, provider),
                fundedPayer(provider.connection),
                fundedPayer(provider.connection),
                provider.connection.getMinimumBalanceForRentExemption(
                  accountSpace(size)
                ),
              ]);

            const [storeRawCu, compResult] = await Promise.all([
              realTxCuWithPayer(
                provider.connection,
                program.methods.storeRaw(data).accounts({
                  store: rawStore.publicKey,
                  payer: rawPayer.publicKey,
                  systemProgram: SystemProgram.programId,
                }),
                rawPayer
              ),
              (async () => {
                try {
                  const cu = await realTxCuWithPayer(
                    provider.connection,
                    program.methods.storeCompressed(data).accounts({
                      store: compStore.publicKey,
                      payer: compPayer.publicKey,
                      systemProgram: SystemProgram.programId,
                    }),
                    compPayer
                  );
                  const compAccount = await program.account.dataStore.fetch(
                    compStore.publicKey
                  );
                  const compSize = (compAccount.data as Buffer).length;
                  const rentComp =
                    await provider.connection.getMinimumBalanceForRentExemption(
                      accountSpace(compSize)
                    );
                  return { cu, compSize, rentComp, oom: false };
                } catch (e: any) {
                  const msg = e.message ?? "";
                  const logs: string[] = [
                    ...(Array.isArray(e.logs) ? e.logs : []),
                    ...(Array.isArray(e.simulationResponse?.logs)
                      ? e.simulationResponse.logs
                      : []),
                  ];
                  if (
                    msg.includes("out of memory") ||
                    logs.some((l: string) => l.includes("out of memory"))
                  ) {
                    return { cu: null, compSize: size, rentComp: rentRaw, oom: true };
                  }
                  throw e;
                }
              })(),
            ]);

            const { cu: storeCompCu, compSize, rentComp, oom } = compResult;
            const rentSaving = rentRaw - rentComp;
            const ratio = (size / compSize).toFixed(2);
            const writeOverhead =
              storeRawCu !== null && storeCompCu !== null
                ? storeCompCu - storeRawCu
                : null;

            let breakEven: string;
            if (oom) {
              breakEven = "OOM";
            } else if (rentSaving <= 0) {
              breakEven = "harmful";
            } else if (writeOverhead !== null && writeOverhead <= 0) {
              breakEven = "always wins";
            } else if (writeOverhead !== null) {
              const writes = Math.round(
                (rentSaving * 1_000_000) /
                  (writeOverhead * PRIORITY_FEE_ULAMPORTS)
              );
              breakEven = writes.toLocaleString("en");
            } else {
              breakEven = "N/A";
            }

            writeFixtures.set(`${label}-${size}`, {
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
          })
        )
      );
    });

    datasets.forEach(({ label }) => {
      WRITE_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, function () {
          const f = writeFixtures.get(`${label}-${size}`)!;
          writeResults.push(f);
          console.log(
            `  [${f.label}] ${f.size}B → ${f.compSize}B (${f.ratio}x)` +
              `  raw=${f.storeRawCu}  comp=${f.storeCompCu}` +
              `  overhead=${f.writeOverhead}` +
              `  rent${f.rentSaving >= 0 ? "+" : ""}${f.rentSaving}` +
              `  break-even=${f.breakEven}`
          );
        });
      });
    });
  });

  // ── Read benchmarks (account-limited sizes) ─────────────────────────────

  describe("READ (account-limited)", () => {
    // Fixtures pre-populated by the top-level before() above.

    datasets.forEach(({ label, gen }) => {
      READ_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, async function () {
          this.timeout(30_000);
          const { rawStore, compStore, compressOom, expectedChecksum,
                  compSize, rentRaw, rentComp } = readLzFixtures.get(`${label}-${size}`)!;

          const rawResult = await simulateWithLogs(
            program.methods.readRaw().accounts({ store: rawStore.publicKey })
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
            assert.strictEqual(compChecksum, expectedChecksum, "roundtrip checksum mismatch");
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

  // ── ChunkedLz4 write benchmark ───────────────────────────────────────────

  describe("WRITE (chunked_lz4)", () => {
    // Same pattern as WRITE (tx-limited): all 12 fixtures measured concurrently.
    const chunkedWriteFixtures = new Map<string, ChunkedWriteRow>();

    before(async function () {
      this.timeout(120_000);
      await Promise.all(
        datasets.flatMap(({ label, gen }) =>
          WRITE_SIZES.map(async (size) => {
            const data = gen(size);
            const [rawStore, chunkedStore, rawPayer, chunkedPayer, rentRaw] =
              await Promise.all([
                createStore(program, provider),
                createStore(program, provider),
                fundedPayer(provider.connection),
                fundedPayer(provider.connection),
                provider.connection.getMinimumBalanceForRentExemption(
                  accountSpace(size)
                ),
              ]);

            const [storeRawCu, chunkedResult] = await Promise.all([
              realTxCuWithPayer(
                provider.connection,
                program.methods.storeRaw(data).accounts({
                  store: rawStore.publicKey,
                  payer: rawPayer.publicKey,
                  systemProgram: SystemProgram.programId,
                }),
                rawPayer
              ),
              (async () => {
                try {
                  const cu = await realTxCuWithPayer(
                    provider.connection,
                    program.methods.storeChunked(data).accounts({
                      store: chunkedStore.publicKey,
                      payer: chunkedPayer.publicKey,
                      systemProgram: SystemProgram.programId,
                    }),
                    chunkedPayer
                  );
                  const compAccount = await program.account.dataStore.fetch(
                    chunkedStore.publicKey
                  );
                  const compSize = (compAccount.data as Buffer).length;
                  const rentComp =
                    await provider.connection.getMinimumBalanceForRentExemption(
                      accountSpace(compSize)
                    );
                  return { cu, compSize, rentComp, oom: false };
                } catch (e: any) {
                  const msg = e.message ?? "";
                  const logs: string[] = [
                    ...(Array.isArray(e.logs) ? e.logs : []),
                    ...(Array.isArray(e.simulationResponse?.logs)
                      ? e.simulationResponse.logs
                      : []),
                  ];
                  if (
                    msg.includes("out of memory") ||
                    logs.some((l: string) => l.includes("out of memory"))
                  ) {
                    return { cu: null, compSize: size, rentComp: rentRaw, oom: true };
                  }
                  throw e;
                }
              })(),
            ]);

            const { cu: storeChunkedCu, compSize, rentComp, oom } = chunkedResult;
            const rentSaving = rentRaw - rentComp;
            const ratio = (size / compSize).toFixed(2);
            const overhead =
              storeRawCu !== null && storeChunkedCu !== null
                ? storeChunkedCu - storeRawCu
                : null;

            let breakEven: string;
            if (oom) {
              breakEven = "OOM";
            } else if (rentSaving <= 0) {
              breakEven = "harmful";
            } else if (overhead !== null && overhead <= 0) {
              breakEven = "always wins";
            } else if (overhead !== null) {
              const writes = Math.round(
                (rentSaving * 1_000_000) / (overhead * PRIORITY_FEE_ULAMPORTS)
              );
              breakEven = writes.toLocaleString("en");
            } else {
              breakEven = "N/A";
            }

            chunkedWriteFixtures.set(`${label}-${size}`, {
              label,
              size,
              compSize,
              ratio,
              storeRawCu,
              storeChunkedCu,
              overhead,
              rentSaving,
              breakEven,
            });
          })
        )
      );
    });

    datasets.forEach(({ label }) => {
      WRITE_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, function () {
          const f = chunkedWriteFixtures.get(`${label}-${size}`)!;
          chunkedWriteResults.push(f);
          console.log(
            `  [${f.label}] ${f.size}B → ${f.compSize}B (${f.ratio}x)` +
              `  raw=${f.storeRawCu}  chunked=${f.storeChunkedCu}` +
              `  overhead=${f.overhead}` +
              `  rent${f.rentSaving >= 0 ? "+" : ""}${f.rentSaving}` +
              `  break-even=${f.breakEven}`
          );
        });
      });
    });
  });

  // ── ChunkedLz4 full-decompress read benchmark ────────────────────────────

  describe("READ (chunked_lz4 full)", () => {
    // Fixtures pre-populated by the top-level before() above.
    // READ (chunked_lz4 per-chunk) reuses these same fixtures.

    datasets.forEach(({ label, gen }) => {
      READ_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, async function () {
          this.timeout(30_000);
          const { rawStore, compStore, compressOom, expectedChecksum,
                  compSize, rentRaw, rentComp } = readChunkedFixtures.get(`${label}-${size}`)!;

          const rawResult = await simulateWithLogs(
            program.methods.readRaw().accounts({ store: rawStore.publicKey })
          );

          let fullResult: { cu: number | null; logs: string[] } = {
            cu: null,
            logs: [],
          };
          if (!compressOom) {
            fullResult = await simulateWithLogs(
              program.methods
                .readChunkedFull()
                .accounts({ store: compStore.publicKey })
            );
          }

          const rawChecksum = parseChecksum(rawResult.logs);
          assert.notStrictEqual(rawChecksum, null, "raw checksum missing");
          assert.strictEqual(rawChecksum, expectedChecksum, "raw checksum mismatch");

          if (!compressOom) {
            const fullChecksum = parseChecksum(fullResult.logs);
            assert.notStrictEqual(fullChecksum, null, "chunked full checksum missing");
            assert.strictEqual(fullChecksum, expectedChecksum, "chunked full roundtrip checksum mismatch");
          }

          const readRawCu = rawResult.cu;
          const readChunkedFullCu = fullResult.cu;
          const overhead =
            readRawCu !== null && readChunkedFullCu !== null
              ? readChunkedFullCu - readRawCu
              : null;
          const rentSaving = rentRaw - rentComp;
          const ratio = (size / compSize).toFixed(2);

          let breakEven: string;
          if (compressOom) {
            breakEven = "OOM";
          } else if (rentSaving <= 0) {
            breakEven = "harmful";
          } else if (overhead !== null && overhead <= 0) {
            breakEven = "always wins";
          } else if (overhead !== null) {
            const reads = Math.round(
              (rentSaving * 1_000_000) / (overhead * PRIORITY_FEE_ULAMPORTS)
            );
            breakEven = reads.toLocaleString("en");
          } else {
            breakEven = "N/A";
          }

          chunkedReadFullResults.push({
            label,
            size,
            compSize,
            ratio,
            readRawCu,
            readChunkedFullCu,
            overhead,
            rentSaving,
            breakEven,
          });

          console.log(
            `  [${label}] ${size}B → ${compSize}B (${ratio}x)` +
              `  rawRead=${readRawCu}  fullRead=${readChunkedFullCu}` +
              `  overhead=${overhead}` +
              `  rent${rentSaving >= 0 ? "+" : ""}${rentSaving}` +
              `  break-even=${breakEven}`
          );
        });
      });
    });
  });

  // ── ChunkedLz4 per-chunk read benchmark ─────────────────────────────────
  // Reuses readChunkedFixtures filled by the before() hook above.

  describe("READ (chunked_lz4 per-chunk)", () => {
    const CHUNK_READ_SIZES = [1024, 4096];
    datasets.forEach(({ label, gen }) => {
      CHUNK_READ_SIZES.forEach((size) => {
        it(`[${label}] ${size}B`, async function () {
          this.timeout(30_000);
          const { rawStore, compStore, compSize } =
            readChunkedFixtures.get(`${label}-${size}`)!;
          const chunkCount = Math.ceil(size / 4096);
          const chunkIdx = 0;

          const rawResult = await simulateWithLogs(
            program.methods.readRaw().accounts({ store: rawStore.publicKey })
          );
          const chunkResult = await simulateWithLogs(
            program.methods
              .readChunkedChunk(chunkIdx)
              .accounts({ store: compStore.publicKey })
          );

          const rawCu = rawResult.cu;
          const chunkCu = chunkResult.cu;
          const overhead =
            rawCu !== null && chunkCu !== null ? chunkCu - rawCu : null;

          chunkedReadChunkResults.push({
            label,
            size,
            compSize,
            chunkCount,
            chunkIdx,
            rawCu,
            chunkCu,
            overhead,
          });

          console.log(
            `  [${label}] ${size}B → ${compSize}B  chunks=${chunkCount}` +
              `  rawRead=${rawCu}  chunkRead=${chunkCu}` +
              `  overhead=${overhead}`
          );
        });
      });
    });
  });

  // ── Heap ceiling probe (random data, both compress paths) ───────────────
  //
  // compress_stored_chunked  uses Account<DataStore>: Anchor deserialises the
  //   full raw Vec<u8> before the instruction body runs, so peak heap =
  //   raw(N) + output(~N for random) + one_chunk_temp(~4 KB).
  //   Expected new ceiling: ~12–14 KB (was ~8 KB before streaming fix).
  //
  // compress_stored_chunked_large uses AccountInfo (zero-copy): no
  //   deserialisation overhead, so peak heap = output(~N) + one_chunk(~4 KB).
  //   Expected new ceiling: ~28 KB (was ~14 KB before streaming fix).

  (SKIP_SLOW ? describe.skip : describe)("HEAP CEILING (random data)", () => {
    const ACCOUNT_SIZES     = [8192, 10240, 12288, 14336, 16384];
    const ACCOUNTINFO_SIZES = [12288, 16384, 20480, 24576, 28672];

    function isOomError(e: any): boolean {
      const msg: string = e.message ?? "";
      // Check all known log locations — never short-circuit with ?? because
      // e.logs may be an empty array [] (truthy) while real logs sit in
      // e.simulationResponse.logs, causing ?? to skip the second source.
      const logs: string[] = [
        ...(Array.isArray(e.logs) ? e.logs : []),
        ...(Array.isArray(e.simulationResponse?.logs) ? e.simulationResponse.logs : []),
      ];
      return (
        msg.includes("out of memory") ||
        logs.some((l: string) => l.includes("out of memory"))
      );
    }

    // Pre-computed results keyed by "account-<size>" or "accountinfo-<size>".
    const heapFixtures = new Map<string, CeilingRow>();

    // All 10 probe streams run concurrently — each gets a dedicated payer so
    // there is no nonce contention on provider.wallet.
    // Bottleneck after parallelisation: 28672 B / 900 B ≈ 32 txs × ~500 ms ≈ 16 s.
    before(async function () {
      this.timeout(300_000);
      await Promise.all([
        ...ACCOUNT_SIZES.map(async (size) => {
          const [store, payer] = await Promise.all([
            createStore(program, provider),
            fundedPayer(provider.connection),
          ]);
          let success = false;
          let compSize: number | null = null;
          try {
            // Upload is inside try-catch: storeRaw deserialises the full
            // accumulated Vec on every call, so it can OOM before we even
            // reach the compression step for large accounts.
            await uploadChunked(program, provider, store, pseudoRandom(size), payer);
            await sendTxWithPayer(
              provider.connection,
              program.methods
                .compressStoredChunked()
                .accounts({
                  store: store.publicKey,
                  payer: payer.publicKey,
                  systemProgram: SystemProgram.programId,
                })
                .preInstructions([
                  ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
                ]),
              payer
            );
            success = true;
            const acc = await program.account.dataStore.fetch(store.publicKey);
            compSize = (acc.data as Buffer).length;
          } catch (e: any) {
            if (!isOomError(e)) throw e;
          }
          heapFixtures.set(`account-${size}`, { path: "account", size, success, compSize });
        }),
        ...ACCOUNTINFO_SIZES.map(async (size) => {
          const [store, payer] = await Promise.all([
            createStore(program, provider),
            fundedPayer(provider.connection),
          ]);
          let success = false;
          let compSize: number | null = null;
          try {
            await uploadLarge(program, provider, store, pseudoRandom(size), payer);
            await sendTxWithPayer(
              provider.connection,
              program.methods
                .compressStoredChunkedLarge()
                .accounts({
                  store: store.publicKey,
                  payer: payer.publicKey,
                  systemProgram: SystemProgram.programId,
                })
                .preInstructions([
                  ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
                ]),
              payer
            );
            success = true;
            const info = await provider.connection.getAccountInfo(
              store.publicKey,
              "confirmed"
            );
            compSize = info!.data.length - 12;
          } catch (e: any) {
            if (!isOomError(e)) throw e;
          }
          heapFixtures.set(`accountinfo-${size}`, { path: "accountinfo", size, success, compSize });
        }),
      ]);
    });

    describe("Account<DataStore> path (compress_stored_chunked)", () => {
      ACCOUNT_SIZES.forEach((size) => {
        it(`random ${size}B`, function () {
          const f = heapFixtures.get(`account-${size}`)!;
          ceilingResults.push(f);
          console.log(
            `  [account] random ${size}B: ${f.success ? `OK compressed=${f.compSize}B` : "OOM"}`
          );
        });
      });
    });

    describe("AccountInfo path (compress_stored_chunked_large)", () => {
      ACCOUNTINFO_SIZES.forEach((size) => {
        it(`random ${size}B`, function () {
          const f = heapFixtures.get(`accountinfo-${size}`)!;
          ceilingResults.push(f);
          console.log(
            `  [accountinfo] random ${size}B: ${f.success ? `OK compressed=${f.compSize}B` : "OOM"}`
          );
        });
      });
    });
  });

  // ── Large account demo (OpenBook-scale, 90 KB) ──────────────────────────

  (SKIP_SLOW ? describe.skip : describe)("LARGE ACCOUNT DEMO (OpenBook-shaped, 90 KB)", () => {
    it("compresses 90 KB orderbook account on-chain and reads per-chunk", async function () {
      this.timeout(300_000);
      const SIZE = 90_952; // exact mainnet OpenBook BookSide size (23 × 4096 B chunks)
      const raw = orderbook(SIZE);

      // 1. Init store + upload raw data via bypass-deserialization instruction
      const [store, storePayer] = await Promise.all([
        createStore(program, provider),
        fundedPayer(provider.connection),
      ]);
      await uploadLarge(program, provider, store, raw, storePayer);

      // 2. Compress in-place — write-through fix eliminates per-chunk temp Vecs;
      //    peak heap ≈ 12.5 KB regardless of account size (for compressible data).
      //    Uses storePayer (same keypair as the upload) to avoid provider.wallet
      //    nonce contention when this runs alongside parallel HEAP CEILING tests.
      const compSig = await sendTxWithPayer(
        provider.connection,
        program.methods
          .compressStoredChunkedLarge()
          .accounts({
            store: store.publicKey,
            payer: storePayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]),
        storePayer
      );

      // Measure actual CU consumed by the compression transaction
      const compTx = await provider.connection.getTransaction(compSig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const compCu = compTx?.meta?.computeUnitsConsumed ?? null;

      // 3. Read resulting compressed account size
      const compInfo = await provider.connection.getAccountInfo(
        store.publicKey,
        "confirmed"
      );
      const compSize = compInfo!.data.length - 12; // subtract 8B discriminator + 4B length

      // 4. Measure per-chunk read CU (chunk 0; all chunks cost identically)
      const chunkCount = Math.ceil(SIZE / 4096); // 23 for 90,952 B
      const chunkSim = await simulateWithLogs(
        program.methods.readChunkedChunk(0).accounts({ store: store.publicKey })
      );
      const chunkCu = chunkSim.cu;

      largeAccountResult = { rawSize: SIZE, compSize, chunkCount, compCu, chunkCu };

      console.log(
        `  OpenBook 90 KB: raw=${SIZE} compressed=${compSize} ratio=${(SIZE / compSize).toFixed(2)}x` +
          ` compressCu=${compCu} chunks=${chunkCount} chunkReadCu=${chunkCu}`
      );
    });
  });

  // ── Output ──────────────────────────────────────────────────────────────

  after("print results", () => {
    const p = (v: string | number, w: number) => String(v).padStart(w);
    const fmt = (n: number | null) =>
      n !== null ? n.toLocaleString("en") : "OOM";

    // Write table
    {
      console.log("\n── WRITE BENCHMARK (tx-limited) ──\n");
      const cols = [
        "data-type",
        "size",
        "comp",
        "ratio",
        "store-raw CU",
        "store-comp CU",
        "overhead",
        "rent-saving",
        "break-even",
      ];
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
      const cols = [
        "data-type",
        "size",
        "comp",
        "ratio",
        "read-raw CU",
        "read-comp CU",
        "overhead",
        "rent-saving",
        "break-even",
      ];
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

    // ChunkedLz4 write table
    {
      console.log("\n── WRITE BENCHMARK (chunked_lz4) ──\n");
      const cols = [
        "data-type",
        "size",
        "comp",
        "ratio",
        "store-raw CU",
        "store-chunk CU",
        "overhead",
        "rent-saving",
        "break-even",
      ];
      const W = [10, 5, 5, 6, 13, 14, 9, 12, 12];
      console.log(cols.map((c, i) => p(c, W[i])).join("  "));
      console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
      for (const r of chunkedWriteResults) {
        console.log(
          [
            p(r.label, W[0]),
            p(r.size, W[1]),
            p(r.compSize, W[2]),
            p(r.ratio + "x", W[3]),
            p(fmt(r.storeRawCu), W[4]),
            p(fmt(r.storeChunkedCu), W[5]),
            p(fmt(r.overhead), W[6]),
            p(r.rentSaving, W[7]),
            p(r.breakEven, W[8]),
          ].join("  ")
        );
      }
    }

    // ChunkedLz4 full-read table
    {
      console.log("\n── READ BENCHMARK (chunked_lz4 full) ──\n");
      const cols = [
        "data-type",
        "size",
        "comp",
        "ratio",
        "read-raw CU",
        "read-full CU",
        "overhead",
        "rent-saving",
        "break-even",
      ];
      const W = [10, 6, 6, 6, 12, 13, 9, 12, 12];
      console.log(cols.map((c, i) => p(c, W[i])).join("  "));
      console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
      let lastLabel = "";
      for (const r of chunkedReadFullResults) {
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
            p(fmt(r.readChunkedFullCu), W[5]),
            p(fmt(r.overhead), W[6]),
            p(r.rentSaving, W[7]),
            p(r.breakEven, W[8]),
          ].join("  ")
        );
      }
    }

    // ChunkedLz4 per-chunk table
    {
      console.log("\n── READ BENCHMARK (chunked_lz4 per-chunk) ──\n");
      const cols = [
        "data-type",
        "size",
        "comp",
        "chunks",
        "chunk-idx",
        "read-raw CU",
        "chunk CU",
        "overhead",
      ];
      const W = [10, 6, 6, 7, 10, 12, 9, 9];
      console.log(cols.map((c, i) => p(c, W[i])).join("  "));
      console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
      let lastLabel = "";
      for (const r of chunkedReadChunkResults) {
        if (r.label !== lastLabel && lastLabel !== "") {
          console.log("─".repeat(W.reduce((a, b) => a + b + 2, 0)));
        }
        lastLabel = r.label;
        console.log(
          [
            p(r.label, W[0]),
            p(r.size, W[1]),
            p(r.compSize, W[2]),
            p(r.chunkCount, W[3]),
            p(r.chunkIdx, W[4]),
            p(fmt(r.rawCu), W[5]),
            p(fmt(r.chunkCu), W[6]),
            p(fmt(r.overhead), W[7]),
          ].join("  ")
        );
      }
    }

    // Ceiling table
    if (ceilingResults.length > 0) {
      console.log("\n── HEAP CEILING (random data, streaming fix) ──\n");
      console.log(
        ["path".padEnd(12), "size".padStart(7), "result".padStart(8), "comp".padStart(8)].join("  ")
      );
      console.log("─".repeat(43));
      for (const r of ceilingResults) {
        console.log(
          [
            r.path.padEnd(12),
            `${r.size}B`.padStart(7),
            (r.success ? "OK" : "OOM").padStart(8),
            (r.compSize !== null ? `${r.compSize}B` : "—").padStart(8),
          ].join("  ")
        );
      }
    }

    // Large account demo summary
    if (largeAccountResult !== null) {
      const r = largeAccountResult;
      const ratio = (r.rawSize / r.compSize).toFixed(2);
      // rent saving: (raw - compressed) bytes * 3480 * 2 lamports/byte (rent-exempt rate)
      const rentSaving = (r.rawSize - r.compSize) * 3480 * 2;
      const rentSol = (rentSaving / 1_000_000_000).toFixed(3);
      const fmtCompCu = r.compCu !== null ? r.compCu.toLocaleString("en") : "N/A";
      const fmtChunkCu = r.chunkCu !== null ? r.chunkCu.toLocaleString("en") : "N/A";
      console.log("\n=== LARGE ACCOUNT DEMO (OpenBook-shaped) ===");
      console.log(
        [
          "raw".padStart(10),
          "compressed".padStart(12),
          "ratio".padStart(8),
          "chunks".padStart(7),
          "compress_cu".padStart(12),
          "chunk_read_cu".padStart(14),
          "rent_saving".padStart(30),
        ].join("  ")
      );
      console.log(
        [
          `${r.rawSize.toLocaleString("en")} B`.padStart(10),
          `${r.compSize.toLocaleString("en")} B`.padStart(12),
          `${ratio}x`.padStart(8),
          String(r.chunkCount).padStart(7),
          fmtCompCu.padStart(12),
          fmtChunkCu.padStart(14),
          `+${rentSaving.toLocaleString("en")} L (~${rentSol} SOL)`.padStart(30),
        ].join("  ")
      );
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
        chunkedWrite: chunkedWriteResults,
        chunkedReadFull: chunkedReadFullResults,
        chunkedReadChunk: chunkedReadChunkResults,
        largeAccountDemo: largeAccountResult,
        heapCeiling: ceilingResults,
      },
      null,
      2
    );
    const outPath = path.join(outDir, "benchmark.json");
    fs.writeFileSync(outPath, json);
    console.log(`\nResults written to ${outPath}`);
  });
});
