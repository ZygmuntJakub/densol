/**
 * scan.ts — count inactive OpenBook v2 markets (no tx in last N days).
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/openbook/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10)
 *   SAMPLE         — check only N random markets, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 *
 * What "inactive" means here:
 *   No transaction on the Market account in the last N days.
 *   An inactive market has two idle BookSide accounts (bids + asks) of 90,952 B
 *   each — compressible via densol ChunkedLZ4 from ~90 KB to ~1.7 KB each.
 *
 * Per-market rent recoverable (from benchmark/drift/benchmark real-world data):
 *   ~0.621 SOL × 2 BookSides = ~1.242 SOL per inactive market
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const OPENBOOK_V2_PROGRAM = new PublicKey(
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb"
);

// Market struct: 840 B + 8 B Anchor discriminator = 848 B total account size
const MARKET_ACCOUNT_SIZE = 848;

// Anchor discriminator = sha256("account:Market")[0..8], base58-encoded
const MARKET_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:Market").digest().slice(0, 8)
);

// OpenOrdersAccount discriminator
const OOA_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:OpenOrdersAccount").digest().slice(0, 8)
);
// OpenOrdersAccount layout: [8 discriminator][32 owner][32 market] → market at offset 40
const OOA_MARKET_OFFSET = 40;

// BookSide struct: 90,944 B + 8 B discriminator = 90,952 B (confirmed on mainnet)
// Compressed size: ~1,693 B (53.7x ratio from real OpenBook SOL/USDC benchmark)
// Rent saved per BookSide: ~0.621 SOL (from compress_bench large account demo)
const RENT_PER_BOOKSIDE_SOL = 0.621;

const SAVE_PATH = path.join(__dirname, "results/scan_results.json");

const RPC_URL       = process.env.RPC_URL       ?? "https://api.mainnet-beta.solana.com";
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

// bids / asks / eventHeap pubkeys for every market (populated from dataSlice at fetch time)
type LargeAccounts = Record<string, { bids: string; asks: string; eventHeap: string }>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function checkMarket(
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

function printSummary(results: Results, totalOnMainnet: number, inactiveOOACount = 0) {
  const counts = { inactive: 0, active: 0, new: 0, error: 0 };
  for (const v of Object.values(results)) counts[v as keyof typeof counts]++;
  const done = counts.inactive + counts.active + counts.new + counts.error;

  const inactiveTotal = counts.inactive + counts.new;
  const rentRecoverable = inactiveTotal * RENT_PER_BOOKSIDE_SOL * 2;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total OpenBook v2 markets:  ${totalOnMainnet.toLocaleString()}`);
  console.log(`Checked:                    ${done.toLocaleString()}`);
  console.log(`Active:                     ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):         ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:                 ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):           ${counts.error.toLocaleString()}`);
  console.log("");
  console.log("Rent recoverable (ChunkedLZ4, ~0.621 SOL per large account):");
  console.log(`  Inactive + never-used markets: ${inactiveTotal.toLocaleString()}`);
  console.log(`  BookSides (2 × 0.621 SOL):     ~${rentRecoverable.toFixed(1)} SOL`);
  console.log(`  EventHeap (1 per market):       ~${(inactiveTotal * RENT_PER_BOOKSIDE_SOL).toFixed(1)} SOL  (estimated — size TBD from benchmark)`);
  console.log(`  Total estimated:                ~${(rentRecoverable + inactiveTotal * RENT_PER_BOOKSIDE_SOL).toFixed(1)} SOL`);
  console.log(`  (source: compress_bench large account demo, real OpenBook SOL/USDC data)`);
  if (inactiveOOACount > 0) {
    console.log("");
    console.log(`OpenOrdersAccounts on inactive markets: ${inactiveOOACount.toLocaleString()}`);
    console.log(`  Rent recoverable: TBD (variable account size — run benchmark to measure)`);
  }
  console.log(`\nResults saved to: ${SAVE_PATH}`);
}

function saveResults(
  results: Results,
  totalOnMainnet: number,
  largeAccounts: LargeAccounts,
  openOrdersAccounts: string[] = [],
) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:      new Date().toISOString(),
    cutoffDays:     INACTIVE_DAYS,
    totalOnMainnet,
    largeAccounts,
    openOrdersAccounts,
    results,
  }, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`RPC:           ${RPC_URL}`);
  console.log(`Inactive if:   no tx in >${INACTIVE_DAYS} days`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Discriminator: ${MARKET_DISCRIMINATOR_B58}`);
  console.log();

  console.log("Fetching all OpenBook v2 Market accounts...");
  const all = await connection.getProgramAccounts(OPENBOOK_V2_PROGRAM, {
    filters: [
      { dataSize: MARKET_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: MARKET_DISCRIMINATOR_B58 } },
    ],
    dataSlice: { offset: 164, length: 96 }, // bids[0..32] asks[32..64] eventHeap[64..96]
  });

  const totalOnMainnet = all.length;
  console.log(`Total on mainnet: ${totalOnMainnet.toLocaleString()}`);

  // Extract bids / asks / eventHeap pubkeys from the fetched data slice
  const largeAccounts: LargeAccounts = {};
  for (const a of all) {
    const d = a.account.data as Buffer;
    largeAccounts[a.pubkey.toBase58()] = {
      bids:      new PublicKey(d.slice(0, 32)).toBase58(),
      asks:      new PublicKey(d.slice(32, 64)).toBase58(),
      eventHeap: new PublicKey(d.slice(64, 96)).toBase58(),
    };
  }

  const allPubkeys = all.map((a) => a.pubkey);
  const pubkeys = SAMPLE > 0
    ? allPubkeys.sort(() => Math.random() - 0.5).slice(0, SAMPLE)
    : allPubkeys;
  console.log(`Checking: ${pubkeys.length.toLocaleString()}${SAMPLE > 0 ? ` (sample of ${SAMPLE})` : ""} markets\n`);

  // Load resume data if provided
  let results: Results = {};
  if (RESUME_PATH && fs.existsSync(RESUME_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    results = saved.results ?? {};
    console.log(`Resuming from ${Object.keys(results).length} already checked markets`);
  }

  _results      = results;
  _total        = totalOnMainnet;
  _largeAccounts = largeAccounts;

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
      if (idx >= pubkeys.length) break;
      const pk  = pubkeys[idx];
      const key = pk.toBase58();
      if (results[key]) continue;

      let status: Status = "error";
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          status = await checkMarket(connection, pk);
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
      const pct  = ((done / pubkeys.length) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] checked=${done}/${pubkeys.length}  inactive=${inactive}  active=${active}  never_used=${fresh}  errors=${errors}`
      );

      if (done % 100 === 0) saveResults(results, totalOnMainnet, largeAccounts);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── OpenOrdersAccount scan ──────────────────────────────────────────────────
  // Fetch all OOAs; filter client-side for those belonging to inactive markets.
  // dataSlice fetches only the market field (offset 40, 32 bytes) to minimise bandwidth.
  process.stdout.write("\nFetching OpenOrdersAccounts...");
  const allOOA = await connection.getProgramAccounts(OPENBOOK_V2_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: OOA_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: OOA_MARKET_OFFSET, length: 32 },
  });
  process.stdout.write(` ${allOOA.length.toLocaleString()} total\n`);

  const inactiveSet = new Set(
    Object.entries(results)
      .filter(([, s]) => s === "inactive" || s === "new")
      .map(([k]) => k)
  );
  const inactiveOOA = allOOA
    .filter(a => inactiveSet.has(new PublicKey(a.account.data.slice(0, 32)).toBase58()))
    .map(a => a.pubkey.toBase58());
  console.log(`OpenOrdersAccounts on inactive markets: ${inactiveOOA.length.toLocaleString()}`);

  _inactiveOOA = inactiveOOA;

  saveResults(results, totalOnMainnet, largeAccounts, inactiveOOA);
  printSummary(results, totalOnMainnet, inactiveOOA.length);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _total   = 0;
let _largeAccounts: LargeAccounts = {};
let _inactiveOOA: string[] = [];

function onExit() {
  saveResults(_results, _total, _largeAccounts, _inactiveOOA);
  printSummary(_results, _total, _inactiveOOA.length);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
