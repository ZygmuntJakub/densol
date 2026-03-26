/**
 * OpenBook v2 BookSide — on-chain compression benchmark (5-market sample)
 * ─────────────────────────────────────────────────────────────────────────────
 * What this does
 *   1. Loads inactive markets from benchmark/openbook/results/scan_results.json.
 *   2. Randomly samples 5 of them, fetches each Market account to resolve the
 *      bids + asks BookSide addresses, then fetches each BookSide (90,952 B).
 *   3. For each BookSide: uploads to localnet via appendRawLarge, compresses
 *      on-chain with densol ChunkedLZ4, measures compress CU (from tx receipt)
 *      and per-chunk decompress CU (simulation of chunk 0).
 *   4. Reports per-BookSide results and averages; extrapolates to all inactive
 *      OpenBook v2 markets on mainnet.
 *
 * Why ChunkedLZ4, not plain LZ4?
 *   BookSide is 90,952 B. Plain LZ4 heap peak ≈ 2× input ≈ 182 KB, exceeding
 *   the 32 KB SBF bump-allocator limit. ChunkedLZ4<4096> processes one 4 KB
 *   chunk at a time; peak heap ≈ 3 KB regardless of total account size.
 *
 * Prerequisites
 *   1. yarn ts-node --transpile-only benchmark/openbook/scan.ts
 *   2. anchor build && anchor deploy  (or anchor test once to deploy)
 *
 * Usage
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY> yarn openbook:bench
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
const SAMPLE_SIZE = 5; // markets; each has 2 BookSides → up to 10 BookSide benchmarks

const UPLOAD_CHUNK_SIZE = 900;
const MAX_CU = 1_400_000;

// BookSide struct: 90,944 B + 8 B Anchor discriminator = 90,952 B (confirmed on mainnet)
const BOOKSIDE_ACCOUNT_SIZE = 90_952;

// DataStore binary layout: [8 B Anchor discriminator][4 B Vec<u8> length][payload]
const ACCOUNT_OVERHEAD = 12;

// Byte offsets within the Market account data (including 8-byte Anchor discriminator):
//   8  (discriminator)
//   +1 (bump) +1 (base_decimals) +1 (quote_decimals) +1 (padding1)
//   +8 (time_expiry i64)
//   +32 (collect_fee_admin) +32 (open_orders_admin) +32 (reduce_only_admin)
//   +32 (close_market_admin) +16 (name[16])
//   = 164 → bids Pubkey, +32 → 196 → asks Pubkey, +32 → 228 → eventHeap Pubkey
const MARKET_BIDS_OFFSET      = 164;
const MARKET_ASKS_OFFSET      = 196;
const MARKET_EVENTHEAP_OFFSET = 228;

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

// ── Per-BookSide benchmark ─────────────────────────────────────────────────

interface BookSideResult {
  market: string;
  side: "bids" | "asks" | "eventHeap";
  pubkey: string;
  compressedPayloadSize: number;
  ratio: number;
  compressCu: number | null;
  chunkReadCu: number | null;
  rentSavedSOL: number;
}

async function benchmarkBookSide(
  market: string,
  side: "bids" | "asks" | "eventHeap",
  pubkey: string,
  bytes: Buffer,
  provider: anchor.AnchorProvider,
  program: Program<CompressBench>,
  payer: Keypair,
): Promise<BookSideResult> {
  const rentRaw = await provider.connection.getMinimumBalanceForRentExemption(
    ACCOUNT_OVERHEAD + bytes.length
  );
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

  // Upload BookSide bytes via zero-copy large-account instruction (900 B chunks)
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = bytes.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length));
    await sendTx(
      provider.connection,
      program.methods.appendRawLarge(chunk).accounts({
        store: storeKp.publicKey,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      }),
      payer
    );
  }

  // Compress on-chain with ChunkedLZ4; read actual CU from tx receipt
  const compSig = await sendTx(
    provider.connection,
    program.methods.compressStoredChunkedLarge().accounts({
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

  // Decompress CU via simulation of chunk 0 (all chunks cost identically)
  const chunkReadCu = await simulateCu(
    program.methods.readChunkedChunk(0).accounts({ store: storeKp.publicKey })
  );

  // Rent savings
  const rentComp = await provider.connection.getMinimumBalanceForRentExemption(compAccountSize);
  const rentSavedSOL = (rentRaw - rentComp) / LAMPORTS_PER_SOL;

  return {
    market,
    side,
    pubkey,
    compressedPayloadSize,
    ratio: bytes.length / compressedPayloadSize,
    compressCu,
    chunkReadCu,
    rentSavedSOL,
  };
}

// ── Benchmark suite ───────────────────────────────────────────────────────

describe("OPENBOOK BOOKSIDES BENCHMARK", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  it(`compresses BookSide accounts for ${SAMPLE_SIZE} random inactive OpenBook v2 markets on-chain`, async function () {
    this.timeout(1_800_000); // 30 min

    const SOL_PRICE = await fetchSolPrice();
    console.log(`\nSOL price: $${SOL_PRICE.toFixed(2)} (Binance)`);

    // ── 1. Load scan results ──────────────────────────────────────────────
    const scanPath = path.join(__dirname, "results/scan_results.json");
    assert(
      fs.existsSync(scanPath),
      `Scan results not found. Run first:\n  RPC_URL=... yarn ts-node --transpile-only benchmark/openbook/scan.ts`
    );
    const scanData = JSON.parse(fs.readFileSync(scanPath, "utf8"));

    const totalOnMainnet: number = scanData.totalOnMainnet ?? 0;
    const inactiveMarkets: string[] = Object.entries(
      scanData.results as Record<string, string>
    )
      .filter(([, status]) => status === "inactive" || status === "new")
      .map(([pubkey]) => pubkey);

    const sample = shuffle(inactiveMarkets).slice(0, SAMPLE_SIZE);
    console.log(
      `\nSampled ${sample.length} markets from ${inactiveMarkets.length.toLocaleString("en")} inactive/never-used`
    );
    console.log(`Total OpenBook v2 markets on mainnet: ${totalOnMainnet.toLocaleString("en")}`);

    // ── 2. Setup shared payer ─────────────────────────────────────────────
    const mainnet = new Connection(MAINNET_RPC, "confirmed");
    // 15 SOL covers rent for up to 15 large DataStore accounts (~0.63–0.75 SOL each) + tx fees
    const payer = await fundedPayer(provider.connection, 15 * LAMPORTS_PER_SOL);

    const fmt = (n: number | null) => n !== null ? n.toLocaleString("en") : "n/a";
    const hr = "─".repeat(84);

    // ── 3. Run benchmark for each sampled market ──────────────────────────
    const results: BookSideResult[] = [];
    let errors = 0;

    const col = {
      mkt:  (s: string) => s.padEnd(17),
      side: (s: string) => s.padEnd(9),
      comp: (s: string) => s.padStart(8),
      rat:  (s: string) => s.padStart(7),
      ccu:  (s: string) => s.padStart(11),
      rcu:  (s: string) => s.padStart(11),
      rent: (s: string) => s.padStart(10),
    };

    console.log(
      `\n  ${col.mkt("Market")}  ${col.side("Side")}  ${col.comp("CompSz")}  ${col.rat("Ratio")}` +
      `  ${col.ccu("CompCU")}  ${col.rcu("ChunkReadCU")}  ${col.rent("RentSaved")}`
    );
    console.log(hr);

    for (let i = 0; i < sample.length; i++) {
      const marketPubkey = sample[i];
      const shortMkt = `${marketPubkey.slice(0, 6)}…${marketPubkey.slice(-6)}`;

      // Fetch Market account to resolve bids/asks BookSide addresses
      let marketInfo;
      try {
        marketInfo = await mainnet.getAccountInfo(new PublicKey(marketPubkey));
      } catch (e: any) {
        console.log(`  ${col.mkt(shortMkt)}  SKIP (RPC error: ${String(e.message).slice(0, 40)})`);
        errors += 2;
        continue;
      }

      if (!marketInfo || marketInfo.data.length !== 848) {
        console.log(`  ${col.mkt(shortMkt)}  SKIP (market not found or wrong size)`);
        errors += 2;
        continue;
      }

      const bidsKey      = new PublicKey(marketInfo.data.slice(MARKET_BIDS_OFFSET,      MARKET_BIDS_OFFSET      + 32));
      const asksKey      = new PublicKey(marketInfo.data.slice(MARKET_ASKS_OFFSET,      MARKET_ASKS_OFFSET      + 32));
      const eventHeapKey = new PublicKey(marketInfo.data.slice(MARKET_EVENTHEAP_OFFSET, MARKET_EVENTHEAP_OFFSET + 32));

      for (const { key, side, expectedSize } of [
        { key: bidsKey,      side: "bids"      as const, expectedSize: BOOKSIDE_ACCOUNT_SIZE },
        { key: asksKey,      side: "asks"      as const, expectedSize: BOOKSIDE_ACCOUNT_SIZE },
        { key: eventHeapKey, side: "eventHeap" as const, expectedSize: null }, // size confirmed in benchmark
      ]) {
        try {
          const info = await mainnet.getAccountInfo(key);
          if (!info || info.data.length < 1_000 || (expectedSize !== null && info.data.length !== expectedSize)) {
            console.log(
              `  ${col.mkt(shortMkt)}  ${col.side(side)}  SKIP (size: ${info?.data.length ?? 0} B)`
            );
            errors++;
            continue;
          }

          const r = await benchmarkBookSide(
            marketPubkey, side, key.toBase58(),
            Buffer.from(info.data),
            provider, program, payer,
          );
          results.push(r);

          console.log(
            `  ${col.mkt(shortMkt)}  ${col.side(side)}` +
            `  ${col.comp(`${r.compressedPayloadSize} B`)}` +
            `  ${col.rat(`${r.ratio.toFixed(1)}x`)}` +
            `  ${col.ccu(fmt(r.compressCu))}` +
            `  ${col.rcu(fmt(r.chunkReadCu))}` +
            `  ${col.rent(`${r.rentSavedSOL.toFixed(4)} SOL`)}`
          );
        } catch (e: any) {
          console.log(`  ${col.mkt(shortMkt)}  ${col.side(side)}  ERROR: ${String(e.message).slice(0, 50)}`);
          errors++;
        }
      }
    }

    // ── 4. Averages and extrapolation ─────────────────────────────────────
    assert(results.length > 0, "all BookSide benchmarks failed");

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const validCu = (key: "compressCu" | "chunkReadCu") =>
      results.map(r => r[key]).filter((v): v is number => v !== null);

    const compSizes   = results.map(r => r.compressedPayloadSize);
    const avgCompSize = avg(compSizes);
    const avgRatio    = avg(results.map(r => r.ratio));
    const avgCompCu   = avg(validCu("compressCu"));
    const avgChunkCu  = avg(validCu("chunkReadCu"));
    const avgRentSOL  = avg(results.map(r => r.rentSavedSOL));
    // bids + asks + eventHeap = 3 large accounts per inactive market
    // avgRentSOL is per-account average across all three types
    const estTotalSOL = inactiveMarkets.length * 3 * avgRentSOL;

    console.log(`\n${hr}`);
    console.log(`AVERAGES  (${results.length}/${sample.length * 2} BookSides succeeded, ${errors} skipped/errored)`);
    console.log(hr);
    console.log(`Compressed size:    ${avgCompSize.toFixed(0)} B avg  (min ${Math.min(...compSizes)} B, max ${Math.max(...compSizes)} B)`);
    console.log(`Compression ratio:  ${avgRatio.toFixed(2)}x avg`);
    console.log(`Compress CU:        ${fmt(Math.round(avgCompCu))}  (one-time keeper cost)`);
    console.log(`Chunk read CU:      ${fmt(Math.round(avgChunkCu))}  (per 4 KB chunk, on demand)`);
    console.log(`Rent saved:         ${avgRentSOL.toFixed(6)} SOL/account avg  (bids + asks + eventHeap)`);
    console.log(hr);
    console.log(`Extrapolation — all inactive OpenBook v2 markets on mainnet`);
    console.log(`  (source: benchmark/openbook/scan.ts)`);
    console.log(`  total markets on mainnet:  ${totalOnMainnet.toLocaleString("en")}`);
    console.log(`  inactive markets:          ${inactiveMarkets.length.toLocaleString("en")}`);
    console.log(`  recoverable rent (3 accounts × ${avgRentSOL.toFixed(4)} SOL avg × ${inactiveMarkets.length.toLocaleString("en")} markets):`);
    console.log(`    ~${estTotalSOL.toFixed(0)} SOL  (~$${(estTotalSOL * SOL_PRICE).toFixed(0)} at $${SOL_PRICE}/SOL)`);
    console.log(hr);
  });
});
