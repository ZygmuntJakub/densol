/**
 * scan.ts — count inactive Raydium CLMM pools and their TickArray accounts.
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/raydium/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint (comma-separated for round-robin, e.g. "https://...key1,https://...key2")
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10)
 *   SAMPLE         — check only N random pools, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 *
 * What "inactive" means here:
 *   No transaction on the PoolState account in the last N days.
 *   An inactive pool has idle TickArrayState accounts (~10 KB each)
 *   compressible via densol ChunkedLZ4.
 *
 * Two-phase approach:
 *   Phase 1: Scan PoolState accounts for inactivity.
 *   Phase 2: Fetch all TickArrayState accounts; filter client-side
 *            for those belonging to inactive pools (pool_id at offset 8).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const RAYDIUM_CLMM_PROGRAM = new PublicKey(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

// Anchor discriminator = sha256("account:<Name>")[0..8], base58-encoded
const POOL_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:PoolState").digest().slice(0, 8)
);
const TICKARRAY_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:TickArrayState").digest().slice(0, 8)
);

// TickArrayState layout: [8 discriminator][32 pool_id] → pool_id at offset 8
const TICKARRAY_POOL_OFFSET = 8;

const SAVE_PATH = path.join(__dirname, "results/scan_results.json");

const RPC_URLS = (process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com")
  .split(",").map(u => u.trim()).filter(Boolean);
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS ?? "30");
const CONCURRENCY   = Number(process.env.CONCURRENCY   ?? "10");
const SAMPLE        = Number(process.env.SAMPLE        ?? "0");
const RESUME_PATH   = process.env.RESUME;

const RPC_TIMEOUT_MS = 10_000;
const MAX_RETRIES    = 5;

const cutoffSec = Math.floor(Date.now() / 1000) - INACTIVE_DAYS * 24 * 3600;

// ── Types ──────────────────────────────────────────────────────────────────────

type Status  = "inactive" | "active" | "new" | "error";
type Results = Record<string, Status>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function checkPool(
  connection: Connection,
  pubkey: PublicKey
): Promise<Status> {
  const sigs = await withTimeout(
    connection.getSignaturesForAddress(pubkey, { limit: 1 }),
    RPC_TIMEOUT_MS
  );

  if (sigs.length === 0) return "new";
  if (sigs[0].blockTime === null) return "active";
  return sigs[0].blockTime < cutoffSec ? "inactive" : "active";
}

function printSummary(
  results: Results,
  totalPools: number,
  totalTickArrays: number,
  inactiveTickArrays: number,
  tickArraySize: number
) {
  const counts = { inactive: 0, active: 0, new: 0, error: 0 };
  for (const v of Object.values(results)) counts[v as keyof typeof counts]++;
  const done = counts.inactive + counts.active + counts.new + counts.error;

  // Rent for a TickArray account (size measured at runtime, estimated here)
  // Solana rent: 3480 lamports/byte/year × 2 years exempt; +128 B account overhead.
  // For 10,240 B: ~0.0722 SOL. Will be confirmed by benchmark.
  const RENT_ESTIMATE_PER_TICKARRAY = tickArraySize > 0
    ? ((tickArraySize + 128) * 3480 * 2) / 1e9
    : 0.0722;
  const rentRecoverable = inactiveTickArrays * RENT_ESTIMATE_PER_TICKARRAY;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total Raydium CLMM pools:   ${totalPools.toLocaleString()}`);
  console.log(`Checked:                    ${done.toLocaleString()}`);
  console.log(`Active:                     ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):         ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:                 ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):           ${counts.error.toLocaleString()}`);
  console.log("");
  console.log(`Total TickArrayState accounts:          ${totalTickArrays.toLocaleString()}`);
  console.log(`TickArrays on inactive pools:           ${inactiveTickArrays.toLocaleString()}`);
  console.log("");
  console.log("Rent recoverable (ChunkedLZ4):");
  console.log(`  TickArray size (estimated):  ~${tickArraySize > 0 ? tickArraySize.toLocaleString() : "~10,232"} B`);
  console.log(`  Rent per TickArray:          ~${RENT_ESTIMATE_PER_TICKARRAY.toFixed(4)} SOL (estimated)`);
  console.log(`  Total recoverable:           ~${rentRecoverable.toFixed(1)} SOL`);
  console.log(`  (exact rent savings: run benchmark/raydium/benchmark.ts)`);
  console.log(`\nResults saved to: ${SAVE_PATH}`);
}

function saveResults(
  results: Results,
  totalPools: number,
  totalTickArrays: number,
  tickArrays: string[],
  tickArraySize: number
) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:      new Date().toISOString(),
    cutoffDays:     INACTIVE_DAYS,
    totalPools,
    totalTickArrays,
    tickArraySize,
    tickArrays,
    results,
  }, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const connections = RPC_URLS.map(url => new Connection(url, "confirmed"));

  console.log(`RPC (${connections.length} endpoint${connections.length > 1 ? "s" : ""} round-robin):`);
  for (const url of RPC_URLS) console.log(`  ${url}`);
  console.log(`Inactive if:      no tx in >${INACTIVE_DAYS} days`);
  console.log(`Concurrency:      ${CONCURRENCY}`);
  console.log(`Pool discrim:     ${POOL_DISCRIMINATOR_B58}`);
  console.log(`TickArray discrim:${TICKARRAY_DISCRIMINATOR_B58}`);
  console.log();

  // ── Phase 1: Fetch all PoolState accounts ───────────────────────────────────
  console.log("Fetching all Raydium CLMM PoolState accounts...");
  const allPools = await connections[0].getProgramAccounts(RAYDIUM_CLMM_PROGRAM, {
    filters: [
      { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } },
    ],
    dataSlice: { offset: 0, length: 0 }, // pubkeys only
  });

  const totalPools = allPools.length;
  console.log(`Total pools on mainnet: ${totalPools.toLocaleString()}`);

  if (totalPools === 0) {
    console.error("ERROR: 0 pools found — check program ID or discriminator.");
    process.exit(1);
  }

  const allPoolPubkeys = allPools.map((a) => a.pubkey);
  const poolPubkeys = SAMPLE > 0
    ? allPoolPubkeys.sort(() => Math.random() - 0.5).slice(0, SAMPLE)
    : allPoolPubkeys;
  console.log(`Checking: ${poolPubkeys.length.toLocaleString()}${SAMPLE > 0 ? ` (sample of ${SAMPLE})` : ""} pools\n`);

  // Load resume data if provided
  let results: Results = {};
  if (RESUME_PATH && fs.existsSync(RESUME_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    results = saved.results ?? {};
    console.log(`Resuming from ${Object.keys(results).length} already checked pools`);
  }

  _results = results;
  _total   = totalPools;

  let active = 0, inactive = 0, fresh = 0, errors = 0;
  for (const v of Object.values(results)) {
    if (v === "active")   active++;
    if (v === "inactive") inactive++;
    if (v === "new")      fresh++;
    if (v === "error")    errors++;
  }

  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= poolPubkeys.length) break;
      const pk  = poolPubkeys[idx];
      const key = pk.toBase58();
      if (results[key]) continue;

      const conn = connections[idx % connections.length];
      let status: Status = "error";
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          status = await checkPool(conn, pk);
          break;
        } catch {
          if (attempt < MAX_RETRIES - 1)
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }

      results[key] = status;
      if (status === "active")   active++;
      if (status === "inactive") inactive++;
      if (status === "new")      fresh++;
      if (status === "error")    errors++;

      const done = active + inactive + fresh + errors;
      const pct  = ((done / poolPubkeys.length) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] checked=${done}/${poolPubkeys.length}  inactive=${inactive}  active=${active}  never_used=${fresh}  errors=${errors}`
      );

      if (done % 100 === 0) saveResults(results, totalPools, _totalTickArrays, _tickArrays, _tickArraySize);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── Phase 2: Fetch all TickArrayState accounts ──────────────────────────────
  process.stdout.write("\nFetching TickArrayState accounts...");
  const allTA = await connections[0].getProgramAccounts(RAYDIUM_CLMM_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: TICKARRAY_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: TICKARRAY_POOL_OFFSET, length: 32 }, // pool_id only
  });
  process.stdout.write(` ${allTA.length.toLocaleString()} total\n`);
  _totalTickArrays = allTA.length;

  if (allTA.length === 0) {
    console.warn("WARNING: 0 TickArrayState accounts found — check discriminator.");
  }

  // Measure TickArray size from a real account (fetch one with full data)
  let tickArraySize = 0;
  if (allTA.length > 0) {
    try {
      const sampleTA = await connections[0].getAccountInfo(allTA[0].pubkey, "confirmed");
      if (sampleTA) tickArraySize = sampleTA.data.length;
      console.log(`TickArrayState account size: ${tickArraySize.toLocaleString()} B`);
    } catch {
      console.warn("Could not fetch TickArray size — using 0 (estimate only)");
    }
  }

  const inactiveSet = new Set(
    Object.entries(results)
      .filter(([, s]) => s === "inactive" || s === "new")
      .map(([k]) => k)
  );
  const inactiveTA = allTA
    .filter(a => inactiveSet.has(new PublicKey(a.account.data.slice(0, 32)).toBase58()))
    .map(a => a.pubkey.toBase58());
  console.log(`TickArrays on inactive pools: ${inactiveTA.length.toLocaleString()}`);

  _tickArrays = inactiveTA;
  _tickArraySize = tickArraySize;

  saveResults(results, totalPools, allTA.length, inactiveTA, tickArraySize);
  printSummary(results, totalPools, allTA.length, inactiveTA.length, tickArraySize);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _total   = 0;
let _totalTickArrays = 0;
let _tickArrays: string[] = [];
let _tickArraySize = 0;

function onExit() {
  saveResults(_results, _total, _totalTickArrays, _tickArrays, _tickArraySize);
  printSummary(_results, _total, _totalTickArrays, _tickArrays.length, _tickArraySize);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
