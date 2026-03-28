/**
 * Meteora DLMM BinArray — on-chain compression benchmark (50-account sample)
 * ─────────────────────────────────────────────────────────────────────────────
 * What this does
 *   1. Loads inactive BinArray pubkeys from benchmark/meteora/results/scan_results.json.
 *   2. Randomly samples 50 of them and fetches their bytes from mainnet.
 *   3. For each: uploads to localnet, compresses on-chain with densol (ChunkedLZ4),
 *      measures compress CU (from tx receipt) and decompress CU (simulation).
 *   4. Reports per-account results and averages; extrapolates to all inactive BinArrays.
 *
 * Instruction choice (selected at runtime based on binArraySize from scan):
 *   ≤ 12 KB → storeRaw + compressStoredChunked   (Account<DataStore>, safe for Anchor deserialize)
 *   > 12 KB → appendRawLarge + compressStoredChunkedLarge  (zero-copy AccountInfo, no OOM)
 *
 * Prerequisites
 *   anchor test --skip-local-validator --skip-deploy  (program already deployed)
 *
 * Usage
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY> yarn meteora:bench
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressBench } from "../../target/types/compress_bench";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────

const MAINNET_RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SAMPLE_SIZE = 50;

const UPLOAD_CHUNK_SIZE = 900;
const MAX_CU = 1_400_000;

// DataStore binary layout: [8 B Anchor discriminator][4 B Vec<u8> length][payload]
const ACCOUNT_OVERHEAD = 12;

// Accounts > 12 KB OOM via Account<DataStore> deserialization — use large-account path
const LARGE_ACCOUNT_THRESHOLD = 12_000;

// ── Helpers ───────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchSolPrice(): Promise<number> {
  if (process.env.SOL_PRICE) return Number(process.env.SOL_PRICE);
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const json = await res.json() as { price: string };
    const price = parseFloat(json.price);
    if (price > 0) return price;
  } catch {}
  return 140;
}

async function fundedPayer(connection: Connection, lamports: number): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function simulateCu(builder: any): Promise<number | null> {
  const result = await builder
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
    .simulate();
  for (let i = result.raw.length - 1; i >= 0; i--) {
    const m = String(result.raw[i]).match(/consumed (\d+) of \d+ compute units/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function sendTx(
  connection: Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  payer: Keypair
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bh = await connection.getLatestBlockhash("confirmed");
      const tx: anchor.web3.Transaction = await builder
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })])
        .transaction();
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const result = await connection.confirmTransaction(
        { signature: sig, ...bh },
        "confirmed"
      );
      if (result.value.err)
        throw new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
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

// ── Per-account benchmark ─────────────────────────────────────────────────

interface AccountResult {
  pubkey: string;
  rawSize: number;
  compressedPayloadSize: number;
  ratio: number;
  compressCu: number | null;
  readCu: number | null;
  rentSavedSOL: number;
  usedLargePath: boolean;
}

async function benchmarkBinArray(
  pubkey: string,
  bytes: Buffer,
  provider: anchor.AnchorProvider,
  program: Program<CompressBench>,
  payer: Keypair,
): Promise<AccountResult> {
  const rawAccountSize = ACCOUNT_OVERHEAD + bytes.length;
  const rentRaw = await provider.connection.getMinimumBalanceForRentExemption(rawAccountSize);
  const usedLargePath = bytes.length > LARGE_ACCOUNT_THRESHOLD;

  // Init store account
  const storeKp = Keypair.generate();
  await program.methods
    .initStore()
    .accounts({
      store: storeKp.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([storeKp])
    .rpc();

  // Upload BinArray bytes in 900 B chunks
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = bytes.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length));
    if (usedLargePath) {
      await sendTx(
        provider.connection,
        program.methods.appendRawLarge(chunk).accounts({
          store: storeKp.publicKey,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        }),
        payer
      );
    } else {
      await sendTx(
        provider.connection,
        program.methods.storeRaw(chunk).accounts({
          store: storeKp.publicKey,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        }),
        payer
      );
    }
  }

  // Compress on-chain with ChunkedLZ4; read actual CU from tx receipt
  let compSig: string;
  if (usedLargePath) {
    compSig = await sendTx(
      provider.connection,
      program.methods.compressStoredChunkedLarge().accounts({
        store: storeKp.publicKey,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      }),
      payer
    );
  } else {
    compSig = await sendTx(
      provider.connection,
      program.methods.compressStoredChunked().accounts({
        store: storeKp.publicKey,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      }),
      payer
    );
  }

  const compTx = await provider.connection.getTransaction(compSig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  const compressCu = compTx?.meta?.computeUnitsConsumed ?? null;

  // Read compressed size
  const compAccInfo = await provider.connection.getAccountInfo(storeKp.publicKey, "confirmed");
  assert(compAccInfo !== null, "account disappeared after compression");
  const compAccountSize = compAccInfo.data.length;
  const compressedPayloadSize = compAccountSize - ACCOUNT_OVERHEAD;

  // Decompress CU via simulation (single chunk)
  const readCu = await simulateCu(
    program.methods.readChunkedChunk(0).accounts({ store: storeKp.publicKey })
  );

  // Rent savings
  const rentComp = await provider.connection.getMinimumBalanceForRentExemption(compAccountSize);
  const rentSavedSOL = (rentRaw - rentComp) / LAMPORTS_PER_SOL;

  return {
    pubkey,
    rawSize: bytes.length,
    compressedPayloadSize,
    ratio: bytes.length / compressedPayloadSize,
    compressCu,
    readCu,
    rentSavedSOL,
    usedLargePath,
  };
}

// ── Benchmark suite ───────────────────────────────────────────────────────

describe("METEORA DLMM BINARRAY BENCHMARK", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  it(`compresses ${SAMPLE_SIZE} random inactive BinArray accounts on-chain and averages results`, async function () {
    this.timeout(1_800_000); // 30 min

    const SOL_PRICE = await fetchSolPrice();
    console.log(`\nSOL price: $${SOL_PRICE.toFixed(2)} (Binance)`);

    // ── 1. Sample accounts from scan results ─────────────────────────────
    const scanPath = path.join(__dirname, "results/scan_results.json");
    assert(fs.existsSync(scanPath), `Scan results not found at ${scanPath} — run scan.ts first`);

    const scanData = JSON.parse(fs.readFileSync(scanPath, "utf8"));
    const inactiveBA: string[] = scanData.binArrays ?? [];
    assert(inactiveBA.length > 0, "No inactive BinArrays in scan results — run scan.ts first");

    const sample = shuffle(inactiveBA).slice(0, SAMPLE_SIZE);
    const largePath = (scanData.binArraySize ?? 0) > LARGE_ACCOUNT_THRESHOLD;
    console.log(
      `\nSampled ${sample.length} BinArrays from ${inactiveBA.length.toLocaleString("en")} inactive`
    );
    console.log(`BinArray size from scan: ${scanData.binArraySize?.toLocaleString() ?? "unknown"} B`);
    console.log(`Upload path: ${largePath ? "appendRawLarge (>12 KB)" : "storeRaw (≤12 KB)"}`);

    // ── 2. Setup shared payer ─────────────────────────────────────────────
    const mainnet = new Connection(MAINNET_RPC, "confirmed");
    const payer = await fundedPayer(provider.connection, 8 * LAMPORTS_PER_SOL);

    const fmt = (n: number | null) => n !== null ? n.toLocaleString("en") : "n/a";
    const hr = "─".repeat(88);

    // ── 3. Run benchmark for each sampled account ─────────────────────────
    const results: AccountResult[] = [];
    let errors = 0;

    const col = {
      i:    (s: string) => s.padStart(3),
      key:  (s: string) => s.padEnd(17),
      raw:  (s: string) => s.padStart(8),
      comp: (s: string) => s.padStart(7),
      rat:  (s: string) => s.padStart(6),
      ccu:  (s: string) => s.padStart(9),
      rcu:  (s: string) => s.padStart(9),
      rent: (s: string) => s.padStart(10),
    };

    console.log(
      `\n${col.i("#")}  ${col.key("Pubkey")}  ${col.raw("RawSz")}  ${col.comp("CompSz")}  ${col.rat("Ratio")}` +
      `  ${col.ccu("CompCU")}  ${col.rcu("DecompCU")}  ${col.rent("RentSaved")}`
    );
    console.log(hr);

    for (let i = 0; i < sample.length; i++) {
      const pubkey = sample[i];
      const shortKey = `${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`;
      try {
        const info = await mainnet.getAccountInfo(new PublicKey(pubkey));
        if (!info) {
          console.log(`${col.i(String(i + 1))}  ${col.key(shortKey)}  SKIP (account not found)`);
          errors++;
          continue;
        }

        const r = await benchmarkBinArray(pubkey, Buffer.from(info.data), provider, program, payer);
        results.push(r);

        console.log(
          `${col.i(String(i + 1))}  ${col.key(shortKey)}` +
          `  ${col.raw(`${r.rawSize} B`)}` +
          `  ${col.comp(`${r.compressedPayloadSize} B`)}` +
          `  ${col.rat(`${r.ratio.toFixed(1)}x`)}` +
          `  ${col.ccu(fmt(r.compressCu))}` +
          `  ${col.rcu(fmt(r.readCu))}` +
          `  ${col.rent(`${r.rentSavedSOL.toFixed(4)} SOL`)}`
        );
      } catch (e: any) {
        console.log(`${col.i(String(i + 1))}  ${col.key(shortKey)}  ERROR: ${String(e.message).slice(0, 50)}`);
        errors++;
      }
    }

    // ── 4. Averages and extrapolation ─────────────────────────────────────
    assert(results.length > 0, "all accounts failed");

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const validCu = (key: "compressCu" | "readCu") =>
      results.map(r => r[key]).filter((v): v is number => v !== null);

    const rawSizes    = results.map(r => r.rawSize);
    const compSizes   = results.map(r => r.compressedPayloadSize);
    const avgRawSize  = avg(rawSizes);
    const avgCompSize = avg(compSizes);
    const avgRatio    = avg(results.map(r => r.ratio));
    const avgCompCu   = avg(validCu("compressCu"));
    const avgReadCu   = avg(validCu("readCu"));
    const avgRentSOL  = avg(results.map(r => r.rentSavedSOL));
    const totalInactiveBA = inactiveBA.length;
    const estTotalSOL = totalInactiveBA * avgRentSOL;

    console.log(`\n${hr}`);
    console.log(`AVERAGES  (${results.length}/${sample.length} succeeded, ${errors} skipped/errored)`);
    console.log(hr);
    console.log(`Raw size:          ${avgRawSize.toFixed(0)} B avg  (min ${Math.min(...rawSizes)} B, max ${Math.max(...rawSizes)} B)`);
    console.log(`Compressed size:   ${avgCompSize.toFixed(0)} B avg  (min ${Math.min(...compSizes)} B, max ${Math.max(...compSizes)} B)`);
    console.log(`Compression ratio: ${avgRatio.toFixed(2)}x avg`);
    console.log(`Compress CU:       ${fmt(Math.round(avgCompCu))}  (one-time keeper cost)`);
    console.log(`Decompress CU:     ${fmt(Math.round(avgReadCu))}  (per chunk read, on demand)`);
    console.log(`Rent saved:        ${avgRentSOL.toFixed(6)} SOL/account`);
    console.log(`Upload path:       ${largePath ? "appendRawLarge + compressStoredChunkedLarge" : "storeRaw + compressStoredChunked"}`);
    console.log(hr);
    console.log(`Extrapolation — all inactive Meteora DLMM BinArrays on mainnet`);
    console.log(`  (source: benchmark/meteora/scan.ts)`);
    console.log(`  inactive BinArrays: ${totalInactiveBA.toLocaleString("en")}`);
    console.log(`  recoverable rent:   ~${estTotalSOL.toFixed(0)} SOL  (~$${(estTotalSOL * SOL_PRICE).toFixed(0)} at $${SOL_PRICE}/SOL)`);
    console.log(hr);
  });
});
