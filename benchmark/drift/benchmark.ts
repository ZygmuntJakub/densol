/**
 * Drift User account — on-chain compression benchmark (100-account sample)
 * ─────────────────────────────────────────────────────────────────────────────
 * What this does
 *   1. Loads inactive accounts from benchmark/drift/results/scan_results.json.
 *   2. Randomly samples 100 of them and fetches their bytes from mainnet.
 *   3. For each: uploads to localnet, compresses on-chain with densol (LZ4),
 *      measures compress CU (from tx receipt) and decompress CU (simulation).
 *   4. Reports per-account results and averages; extrapolates to full mainnet
 *      Drift User population (207,987 accounts, 93.2% inactive).
 *
 * Why plain LZ4, not ChunkedLZ4?
 *   Drift User is 4376 B. Plain LZ4 heap peak ≈ 2× input ≈ 8.7 KB, well
 *   within the 32 KB SBF limit. Full-account window also gives better ratio
 *   than 4 KB chunks. ChunkedLZ4 is only needed for accounts > ~12 KB.
 *
 * About rent numbers
 *   compress_stored does NOT refund freed lamports — the account becomes
 *   over-funded. A real Drift instruction would transfer the excess back to
 *   the user (see compress_stored_chunked_large in lib.rs:363-368).
 *
 * Prerequisites
 *   anchor build && anchor deploy  (or anchor test once to deploy)
 *
 * Usage
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY> yarn drift:bench
 *
 * Env vars
 *   RPC_URL   — mainnet RPC (default: public endpoint)
 *   SOL_PRICE — override SOL/USD price (default: live Binance fetch)
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
const SAMPLE_SIZE = 100;

const UPLOAD_CHUNK_SIZE = 900;
const MAX_CU = 1_400_000;

// From drift-labs/protocol-v2: programs/drift/src/state/user.rs
const DRIFT_USER_SIZE = 4376;

// DataStore binary layout: [8 B Anchor discriminator][4 B Vec<u8> length][payload]
const ACCOUNT_OVERHEAD = 12;

// Mainnet population stats from benchmark/drift/scan.ts — full scan March 2026
const TOTAL_MAINNET_ACCOUNTS = 207_987;
const INACTIVE_ACCOUNTS      = 193_866;

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
  compressedPayloadSize: number;
  ratio: number;
  compressCu: number | null;
  readCu: number | null;
  rentSavedSOL: number;
}

async function benchmarkAccount(
  pubkey: string,
  bytes: Buffer,
  provider: anchor.AnchorProvider,
  program: Program<CompressBench>,
  payer: Keypair,
  rentRaw: number,
): Promise<AccountResult> {
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

  // Upload Drift User bytes in 900 B chunks
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = bytes.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length));
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

  // Compress on-chain; read actual CU from tx receipt
  const compSig = await sendTx(
    provider.connection,
    program.methods.compressStored().accounts({
      store: storeKp.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    }),
    payer
  );
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

  // Decompress CU via simulation
  const readCu = await simulateCu(
    program.methods.readCompressed().accounts({ store: storeKp.publicKey })
  );

  // Rent savings
  const rentComp = await provider.connection.getMinimumBalanceForRentExemption(compAccountSize);
  const rentSavedSOL = (rentRaw - rentComp) / LAMPORTS_PER_SOL;

  return {
    pubkey,
    compressedPayloadSize,
    ratio: DRIFT_USER_SIZE / compressedPayloadSize,
    compressCu,
    readCu,
    rentSavedSOL,
  };
}

// ── Benchmark suite ───────────────────────────────────────────────────────

describe("DRIFT USER BENCHMARK", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  it(`compresses ${SAMPLE_SIZE} random inactive Drift User accounts on-chain and averages results`, async function () {
    this.timeout(1_800_000); // 30 min for 100 accounts

    const SOL_PRICE = await fetchSolPrice();
    console.log(`\nSOL price: $${SOL_PRICE.toFixed(2)} (Binance)`);

    // ── 1. Sample accounts from scan results ─────────────────────────────
    const scanData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "results/scan_results.json"), "utf8")
    );
    const inactivePubkeys: string[] = Object.entries(
      scanData.results as Record<string, string>
    )
      .filter(([, status]) => status === "inactive")
      .map(([pubkey]) => pubkey);

    const sample = shuffle(inactivePubkeys).slice(0, SAMPLE_SIZE);
    console.log(
      `\nSampled ${sample.length} accounts from ${inactivePubkeys.length.toLocaleString("en")} inactive`
    );

    // ── 2. Setup shared payer and rent baseline ───────────────────────────
    const mainnet = new Connection(MAINNET_RPC, "confirmed");
    // 10 SOL covers rent growth for 100 accounts (~0.031 SOL each) + tx fees
    const payer = await fundedPayer(provider.connection, 10 * LAMPORTS_PER_SOL);
    const rawAccountSize = ACCOUNT_OVERHEAD + DRIFT_USER_SIZE; // 4388 B
    const rentRaw = await provider.connection.getMinimumBalanceForRentExemption(rawAccountSize);

    const fmt = (n: number | null) => n !== null ? n.toLocaleString("en") : "n/a";
    const hr = "─".repeat(76);

    // ── 3. Run benchmark for each sampled account ─────────────────────────
    const results: AccountResult[] = [];
    let errors = 0;

    const col = {
      i:    (s: string) => s.padStart(3),
      key:  (s: string) => s.padEnd(17),
      comp: (s: string) => s.padStart(7),
      rat:  (s: string) => s.padStart(6),
      ccu:  (s: string) => s.padStart(9),
      rcu:  (s: string) => s.padStart(9),
      rent: (s: string) => s.padStart(10),
    };

    console.log(
      `\n${col.i("#")}  ${col.key("Pubkey")}  ${col.comp("CompSz")}  ${col.rat("Ratio")}` +
      `  ${col.ccu("CompCU")}  ${col.rcu("DecompCU")}  ${col.rent("RentSaved")}`
    );
    console.log(hr);

    for (let i = 0; i < sample.length; i++) {
      const pubkey = sample[i];
      const shortKey = `${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`;
      try {
        const info = await mainnet.getAccountInfo(new PublicKey(pubkey));
        if (!info || info.data.length !== DRIFT_USER_SIZE) {
          console.log(`${col.i(String(i + 1))}  ${col.key(shortKey)}  SKIP (not found or wrong size)`);
          errors++;
          continue;
        }

        const r = await benchmarkAccount(pubkey, Buffer.from(info.data), provider, program, payer, rentRaw);
        results.push(r);

        console.log(
          `${col.i(String(i + 1))}  ${col.key(shortKey)}` +
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

    const compSizes   = results.map(r => r.compressedPayloadSize);
    const avgCompSize = avg(compSizes);
    const avgRatio    = avg(results.map(r => r.ratio));
    const avgCompCu   = avg(validCu("compressCu"));
    const avgReadCu   = avg(validCu("readCu"));
    const avgRentSOL  = avg(results.map(r => r.rentSavedSOL));
    const estTotalSOL = INACTIVE_ACCOUNTS * avgRentSOL;

    console.log(`\n${hr}`);
    console.log(`AVERAGES  (${results.length}/${SAMPLE_SIZE} succeeded, ${errors} skipped/errored)`);
    console.log(hr);
    console.log(`Compressed size:   ${avgCompSize.toFixed(0)} B avg  (min ${Math.min(...compSizes)} B, max ${Math.max(...compSizes)} B)`);
    console.log(`Compression ratio: ${avgRatio.toFixed(2)}x avg`);
    console.log(`Compress CU:       ${fmt(Math.round(avgCompCu))}  (one-time keeper cost)`);
    console.log(`Decompress CU:     ${fmt(Math.round(avgReadCu))}  (per read, on demand)`);
    console.log(`Rent saved:        ${avgRentSOL.toFixed(6)} SOL/account`);
    console.log(`  before: ${(rentRaw / LAMPORTS_PER_SOL).toFixed(6)} SOL  (${rawAccountSize} B)`);
    console.log(`  note: production instruction must explicitly refund freed lamports to user`);
    console.log(hr);
    console.log(`Extrapolation — all Drift User accounts on mainnet`);
    console.log(`  (source: benchmark/drift/scan.ts, full scan March 2026)`);
    console.log(`  total accounts:    ${TOTAL_MAINNET_ACCOUNTS.toLocaleString("en")}`);
    console.log(`  inactive (>30 d):  ${INACTIVE_ACCOUNTS.toLocaleString("en")}  (93.2%)`);
    console.log(`  recoverable rent:  ~${estTotalSOL.toFixed(0)} SOL  (~$${(estTotalSOL * SOL_PRICE).toFixed(0)} at $${SOL_PRICE}/SOL)`);
    console.log(hr);
  });
});
