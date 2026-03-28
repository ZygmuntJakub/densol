/**
 * scan.ts — count inactive Meteora DLMM pools and their BinArray accounts.
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/meteora/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint (comma-separated for round-robin)
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10)
 *   SAMPLE         — check only N random pools, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 *
 * Two-phase approach:
 *   Phase 1: Scan LbPair accounts for inactivity via getSignaturesForAddress.
 *   Phase 2: Fetch all BinArray accounts; filter client-side for those
 *            belonging to inactive pools (lb_pair pubkey auto-detected offset).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const METEORA_DLMM_PROGRAM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

// Anchor discriminator = sha256("account:<Name>")[0..8], base58-encoded
const LBPAIR_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:LbPair").digest().slice(0, 8)
);
const BINARRAY_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:BinArray").digest().slice(0, 8)
);

// Decoded as Buffer for discriminator comparison
const LBPAIR_DISCRIMINATOR_BUF = Buffer.from(
  createHash("sha256").update("account:LbPair").digest().slice(0, 8)
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

async function checkPair(
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

// Auto-detect the offset of lb_pair pubkey within BinArray account data.
// Tries candidate offsets and checks if decoded bytes form a valid LbPair pubkey.
async function detectLbPairOffset(
  connection: Connection,
  samplePubkey: PublicKey
): Promise<number> {
  const info = await connection.getAccountInfo(samplePubkey, "confirmed");
  if (!info) throw new Error("Cannot fetch sample BinArray for offset detection");

  const data = info.data as Buffer;
  for (const offset of [8, 16, 24, 40, 48]) {
    if (offset + 32 > data.length) continue;
    try {
      const candidate = new PublicKey(data.slice(offset, offset + 32));
      const candidateInfo = await connection.getAccountInfo(candidate, "confirmed");
      if (
        candidateInfo &&
        candidateInfo.data.length >= 8 &&
        Buffer.from(candidateInfo.data).slice(0, 8).equals(LBPAIR_DISCRIMINATOR_BUF)
      ) {
        console.log(`Detected lb_pair offset: ${offset}`);
        return offset;
      }
    } catch {
      // invalid pubkey bytes, try next offset
    }
  }
  throw new Error(
    "Cannot detect lb_pair offset in BinArray — check account discriminator or struct layout"
  );
}

function printSummary(
  results: Results,
  totalPools: number,
  totalBinArrays: number,
  inactiveBinArrays: number,
  binArraySize: number
) {
  const counts = { inactive: 0, active: 0, new: 0, error: 0 };
  for (const v of Object.values(results)) counts[v as keyof typeof counts]++;
  const done = counts.inactive + counts.active + counts.new + counts.error;

  // Solana rent: 3480 lamports/byte/year × 2 years exempt; +128 B account overhead
  const RENT_ESTIMATE_PER_BINARRAY = binArraySize > 0
    ? ((binArraySize + 128) * 3480 * 2) / 1e9
    : 0.10;
  const rentRecoverable = inactiveBinArrays * RENT_ESTIMATE_PER_BINARRAY;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total Meteora DLMM pools:   ${totalPools.toLocaleString()}`);
  console.log(`Checked:                    ${done.toLocaleString()}`);
  console.log(`Active:                     ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):         ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:                 ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):           ${counts.error.toLocaleString()}`);
  console.log("");
  console.log(`Total BinArray accounts:             ${totalBinArrays.toLocaleString()}`);
  console.log(`BinArrays on inactive pools:         ${inactiveBinArrays.toLocaleString()}`);
  console.log("");
  console.log("Rent recoverable (ChunkedLZ4):");
  console.log(`  BinArray size:    ~${binArraySize > 0 ? binArraySize.toLocaleString() : "unknown"} B`);
  console.log(`  Rent per BinArray: ~${RENT_ESTIMATE_PER_BINARRAY.toFixed(4)} SOL (estimated)`);
  console.log(`  Total recoverable: ~${rentRecoverable.toFixed(1)} SOL`);
  console.log(`  (exact rent savings: run benchmark/meteora/benchmark.ts)`);
  console.log(`\nResults saved to: ${SAVE_PATH}`);
}

function saveResults(
  results: Results,
  totalPools: number,
  totalBinArrays: number,
  binArrays: string[],
  binArraySize: number,
  lbPairOffset: number
) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:      new Date().toISOString(),
    cutoffDays:     INACTIVE_DAYS,
    totalPools,
    totalBinArrays,
    binArraySize,
    lbPairOffset,
    binArrays,
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
  console.log(`LbPair discrim:    ${LBPAIR_DISCRIMINATOR_B58}`);
  console.log(`BinArray discrim:  ${BINARRAY_DISCRIMINATOR_B58}`);
  console.log();

  // ── Phase 1: Fetch all LbPair accounts ─────────────────────────────────────
  console.log("Fetching all Meteora DLMM LbPair accounts...");
  const allPairs = await connections[0].getProgramAccounts(METEORA_DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: LBPAIR_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: 0, length: 0 }, // pubkeys only
  });

  const totalPools = allPairs.length;
  console.log(`Total pools on mainnet: ${totalPools.toLocaleString()}`);

  if (totalPools === 0) {
    console.error("ERROR: 0 pools found — check program ID or discriminator.");
    process.exit(1);
  }

  const allPairPubkeys = allPairs.map((a) => a.pubkey);
  const pairPubkeys = SAMPLE > 0
    ? allPairPubkeys.sort(() => Math.random() - 0.5).slice(0, SAMPLE)
    : allPairPubkeys;
  console.log(`Checking: ${pairPubkeys.length.toLocaleString()}${SAMPLE > 0 ? ` (sample of ${SAMPLE})` : ""} pools\n`);

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
      if (idx >= pairPubkeys.length) break;
      const pk  = pairPubkeys[idx];
      const key = pk.toBase58();
      if (results[key]) continue;

      const conn = connections[idx % connections.length];
      let status: Status = "error";
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          status = await checkPair(conn, pk);
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
      const pct  = ((done / pairPubkeys.length) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] checked=${done}/${pairPubkeys.length}  inactive=${inactive}  active=${active}  never_used=${fresh}  errors=${errors}`
      );

      if (done % 100 === 0) saveResults(results, totalPools, _totalBinArrays, _binArrays, _binArraySize, _lbPairOffset);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── Phase 2: Fetch all BinArray accounts ────────────────────────────────────
  process.stdout.write("\nFetching BinArray accounts (full data for one, pubkeys for rest)...");

  // Fetch one BinArray with full data for offset detection + size measurement
  const oneBA = await connections[0].getProgramAccounts(METEORA_DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: BINARRAY_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: 0, length: 0 },
  });
  process.stdout.write(` ${oneBA.length.toLocaleString()} total\n`);
  _totalBinArrays = oneBA.length;

  if (oneBA.length === 0) {
    console.warn("WARNING: 0 BinArray accounts found — check discriminator.");
    saveResults(results, totalPools, 0, [], 0, 0);
    printSummary(results, totalPools, 0, 0, 0);
    return;
  }

  // Measure size and detect lb_pair offset from a real account
  let binArraySize = 0;
  let lbPairOffset = 0;
  try {
    const sampleInfo = await connections[0].getAccountInfo(oneBA[0].pubkey, "confirmed");
    if (sampleInfo) {
      binArraySize = sampleInfo.data.length;
      console.log(`BinArray account size: ${binArraySize.toLocaleString()} B`);
    }
    lbPairOffset = await detectLbPairOffset(connections[0], oneBA[0].pubkey);
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  _binArraySize  = binArraySize;
  _lbPairOffset  = lbPairOffset;

  // Now fetch all BinArrays with just the lb_pair slice
  process.stdout.write("Fetching BinArray lb_pair fields...");
  const allBA = await connections[0].getProgramAccounts(METEORA_DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: BINARRAY_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: lbPairOffset, length: 32 },
  });
  process.stdout.write(` done\n`);

  const inactiveSet = new Set(
    Object.entries(results)
      .filter(([, s]) => s === "inactive" || s === "new")
      .map(([k]) => k)
  );
  const inactiveBA = allBA
    .filter(a => {
      try {
        return inactiveSet.has(new PublicKey(a.account.data.slice(0, 32)).toBase58());
      } catch { return false; }
    })
    .map(a => a.pubkey.toBase58());
  console.log(`BinArrays on inactive pools: ${inactiveBA.length.toLocaleString()}`);

  _binArrays = inactiveBA;

  saveResults(results, totalPools, allBA.length, inactiveBA, binArraySize, lbPairOffset);
  printSummary(results, totalPools, allBA.length, inactiveBA.length, binArraySize);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _total          = 0;
let _totalBinArrays = 0;
let _binArrays: string[] = [];
let _binArraySize   = 0;
let _lbPairOffset   = 0;

function onExit() {
  saveResults(_results, _total, _totalBinArrays, _binArrays, _binArraySize, _lbPairOffset);
  printSummary(_results, _total, _totalBinArrays, _binArrays.length, _binArraySize);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
