/**
 * scan.ts — count inactive Orca Whirlpools and their TickArray accounts.
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/orca/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint (comma-separated for round-robin)
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10)
 *   SAMPLE         — check only N random pools, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 *
 * Two-phase approach:
 *   Phase 1: Scan Whirlpool accounts for inactivity via getSignaturesForAddress.
 *   Phase 2: Fetch all TickArray accounts; filter client-side for those
 *            belonging to inactive pools (whirlpool pubkey at offset size-32).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

const WHIRLPOOL_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:Whirlpool").digest().slice(0, 8)
);
const TICKARRAY_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:TickArray").digest().slice(0, 8)
);

const WHIRLPOOL_DISCRIMINATOR_BUF = Buffer.from(
  createHash("sha256").update("account:Whirlpool").digest().slice(0, 8)
);

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

// Detect whirlpool pubkey offset within TickArray account data.
// FixedTickArray layout: [8B discriminator][4B start_tick_index][88 * 113B ticks][32B whirlpool]
// → whirlpool is at offset size - 32 = 9,956 for the standard 9,988 B account.
async function detectWhirlpoolOffset(
  connection: Connection,
  samplePubkey: PublicKey,
  tickArraySize: number
): Promise<number> {
  const info = await connection.getAccountInfo(samplePubkey, "confirmed");
  if (!info) throw new Error("Cannot fetch sample TickArray for offset detection");

  const data = info.data as Buffer;
  // Try known end-of-struct offset first, then fallback candidates
  const candidates = [tickArraySize - 32, 8, 16, 24, 40, 48];

  for (const offset of candidates) {
    if (offset < 0 || offset + 32 > data.length) continue;
    try {
      const candidate = new PublicKey(data.slice(offset, offset + 32));
      const candidateInfo = await connection.getAccountInfo(candidate, "confirmed");
      if (
        candidateInfo &&
        candidateInfo.data.length >= 8 &&
        Buffer.from(candidateInfo.data).slice(0, 8).equals(WHIRLPOOL_DISCRIMINATOR_BUF)
      ) {
        console.log(`Detected whirlpool offset: ${offset}`);
        return offset;
      }
    } catch {
      // invalid pubkey bytes, try next offset
    }
  }
  throw new Error(
    "Cannot detect whirlpool offset in TickArray — check account discriminator or struct layout"
  );
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

  const RENT_ESTIMATE_PER_TA = tickArraySize > 0
    ? ((tickArraySize + 128) * 3480 * 2) / 1e9
    : 0.07;
  const rentRecoverable = inactiveTickArrays * RENT_ESTIMATE_PER_TA;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total Orca Whirlpools:      ${totalPools.toLocaleString()}`);
  console.log(`Checked:                    ${done.toLocaleString()}`);
  console.log(`Active:                     ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):         ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:                 ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):           ${counts.error.toLocaleString()}`);
  console.log("");
  console.log(`Total TickArray accounts:            ${totalTickArrays.toLocaleString()}`);
  console.log(`TickArrays on inactive pools:        ${inactiveTickArrays.toLocaleString()}`);
  console.log("");
  console.log("Rent recoverable (ChunkedLZ4):");
  console.log(`  TickArray size:    ~${tickArraySize > 0 ? tickArraySize.toLocaleString() : "unknown"} B`);
  console.log(`  Rent per TickArray: ~${RENT_ESTIMATE_PER_TA.toFixed(4)} SOL (estimated)`);
  console.log(`  Total recoverable: ~${rentRecoverable.toFixed(1)} SOL`);
  console.log(`  (exact rent savings: run benchmark/orca/benchmark.ts)`);
  console.log(`\nResults saved to: ${SAVE_PATH}`);
}

function saveResults(
  results: Results,
  totalPools: number,
  totalTickArrays: number,
  tickArrays: string[],
  tickArraySize: number,
  whirlpoolOffset: number
) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:      new Date().toISOString(),
    cutoffDays:     INACTIVE_DAYS,
    totalPools,
    totalTickArrays,
    tickArraySize,
    whirlpoolOffset,
    tickArrays,
    results,
  }, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const connections = RPC_URLS.map(url => new Connection(url, "confirmed"));

  console.log(`RPC (${connections.length} endpoint${connections.length > 1 ? "s" : ""} round-robin):`);
  for (const url of RPC_URLS) console.log(`  ${url}`);
  console.log(`Inactive if:       no tx in >${INACTIVE_DAYS} days`);
  console.log(`Concurrency:       ${CONCURRENCY}`);
  console.log(`Whirlpool discrim: ${WHIRLPOOL_DISCRIMINATOR_B58}`);
  console.log(`TickArray discrim: ${TICKARRAY_DISCRIMINATOR_B58}`);
  console.log();

  // ── Phase 1: Fetch all Whirlpool accounts ───────────────────────────────────
  console.log("Fetching all Orca Whirlpool accounts...");
  const allPools = await connections[0].getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: WHIRLPOOL_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: 0, length: 0 },
  });

  const totalPools = allPools.length;
  console.log(`Total whirlpools on mainnet: ${totalPools.toLocaleString()}`);

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

      if (done % 100 === 0) saveResults(results, totalPools, _totalTickArrays, _tickArrays, _tickArraySize, _whirlpoolOffset);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── Phase 2: Fetch all TickArray accounts ───────────────────────────────────
  process.stdout.write("\nFetching TickArray accounts (size + offset detection)...");

  const oneTA = await connections[0].getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: TICKARRAY_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: 0, length: 0 },
  });
  process.stdout.write(` ${oneTA.length.toLocaleString()} total\n`);
  _totalTickArrays = oneTA.length;

  if (oneTA.length === 0) {
    console.warn("WARNING: 0 TickArray accounts found — check discriminator.");
    saveResults(results, totalPools, 0, [], 0, 0);
    printSummary(results, totalPools, 0, 0, 0);
    return;
  }

  // Measure size and detect whirlpool offset from a real account
  let tickArraySize = 0;
  let whirlpoolOffset = 0;
  try {
    const sampleInfo = await connections[0].getAccountInfo(oneTA[0].pubkey, "confirmed");
    if (sampleInfo) {
      tickArraySize = sampleInfo.data.length;
      console.log(`TickArray account size: ${tickArraySize.toLocaleString()} B`);
    }
    whirlpoolOffset = await detectWhirlpoolOffset(connections[0], oneTA[0].pubkey, tickArraySize);
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  _tickArraySize    = tickArraySize;
  _whirlpoolOffset  = whirlpoolOffset;

  // Fetch all TickArrays with just the whirlpool slice
  process.stdout.write("Fetching TickArray whirlpool fields...");
  const allTA = await connections[0].getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: TICKARRAY_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: whirlpoolOffset, length: 32 },
  });
  process.stdout.write(` done\n`);

  const inactiveSet = new Set(
    Object.entries(results)
      .filter(([, s]) => s === "inactive" || s === "new")
      .map(([k]) => k)
  );
  const inactiveTA = allTA
    .filter(a => {
      try {
        return inactiveSet.has(new PublicKey(a.account.data.slice(0, 32)).toBase58());
      } catch { return false; }
    })
    .map(a => a.pubkey.toBase58());
  console.log(`TickArrays on inactive pools: ${inactiveTA.length.toLocaleString()}`);

  _tickArrays = inactiveTA;

  saveResults(results, totalPools, allTA.length, inactiveTA, tickArraySize, whirlpoolOffset);
  printSummary(results, totalPools, allTA.length, inactiveTA.length, tickArraySize);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _total            = 0;
let _totalTickArrays  = 0;
let _tickArrays: string[] = [];
let _tickArraySize    = 0;
let _whirlpoolOffset  = 0;

function onExit() {
  saveResults(_results, _total, _totalTickArrays, _tickArrays, _tickArraySize, _whirlpoolOffset);
  printSummary(_results, _total, _totalTickArrays, _tickArrays.length, _tickArraySize);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
