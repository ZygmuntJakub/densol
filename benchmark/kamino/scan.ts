/**
 * scan.ts — count inactive Kamino Lending Obligation accounts.
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/kamino/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint (comma-separated for round-robin)
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10)
 *   SAMPLE         — check only N random accounts, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 *
 * Single-phase scan: fetch all Obligation pubkeys, check each for inactivity
 * via getSignaturesForAddress.
 *
 * Account facts (confirmed from mainnet):
 *   Program:       KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
 *   Discriminator: [168, 206, 141, 106, 88, 76, 172, 167]  (Borsh #[account])
 *   Size:          3,344 B  (8 deposits × ObligationCollateral + 5 borrows × ObligationLiquidity + metadata)
 *
 * Inactive obligations have zero-filled deposit/borrow slots → highly compressible.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const KAMINO_LEND_PROGRAM = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

// Discriminator from klend-sdk codegen (Anchor Borsh account)
const OBLIGATION_DISCRIMINATOR = Buffer.from([168, 206, 141, 106, 88, 76, 172, 167]);
const OBLIGATION_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(OBLIGATION_DISCRIMINATOR);

const OBLIGATION_SIZE = 3344; // confirmed from mainnet getAccountInfo

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

async function checkAccount(connection: Connection, pubkey: PublicKey): Promise<Status> {
  const sigs = await withTimeout(
    connection.getSignaturesForAddress(pubkey, { limit: 1 }),
    RPC_TIMEOUT_MS
  );
  if (sigs.length === 0) return "new";
  if (sigs[0].blockTime === null) return "active";
  return sigs[0].blockTime < cutoffSec ? "inactive" : "active";
}

function printSummary(results: Results, totalAccounts: number, accountSize: number) {
  const counts = { inactive: 0, active: 0, new: 0, error: 0 };
  for (const v of Object.values(results)) counts[v as keyof typeof counts]++;
  const done = counts.inactive + counts.active + counts.new + counts.error;

  const RENT_ESTIMATE = accountSize > 0
    ? ((accountSize + 128) * 3480 * 2) / 1e9
    : 0.024;
  const inactiveCount = counts.inactive + counts.new;
  const rentRecoverable = inactiveCount * RENT_ESTIMATE;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total Obligations:          ${totalAccounts.toLocaleString()}`);
  console.log(`Checked:                    ${done.toLocaleString()}`);
  console.log(`Active:                     ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):         ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:                 ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):           ${counts.error.toLocaleString()}`);
  console.log("");
  console.log("Rent recoverable (ChunkedLZ4):");
  console.log(`  Account size:      ~${accountSize.toLocaleString()} B`);
  console.log(`  Rent per account:  ~${RENT_ESTIMATE.toFixed(4)} SOL (estimated)`);
  console.log(`  Inactive accounts: ${inactiveCount.toLocaleString()}`);
  console.log(`  Total recoverable: ~${rentRecoverable.toFixed(1)} SOL`);
  console.log(`  (exact rent savings: run benchmark/kamino/benchmark.ts)`);
  console.log(`\nResults saved to: ${SAVE_PATH}`);
}

function saveResults(results: Results, totalAccounts: number, inactive: string[], accountSize: number) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:    new Date().toISOString(),
    cutoffDays:   INACTIVE_DAYS,
    totalAccounts,
    accountSize,
    accounts:     inactive,
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
  console.log(`Discriminator:     ${OBLIGATION_DISCRIMINATOR_B58}`);
  console.log(`Account size:      ${OBLIGATION_SIZE} B`);
  console.log();

  console.log("Fetching all Kamino Obligation accounts...");
  const allAccounts = await connections[0].getProgramAccounts(KAMINO_LEND_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: OBLIGATION_DISCRIMINATOR_B58 } }],
    dataSlice: { offset: 0, length: 0 },
  });

  const totalAccounts = allAccounts.length;
  console.log(`Total Obligations on mainnet: ${totalAccounts.toLocaleString()}`);

  if (totalAccounts === 0) {
    console.error("ERROR: 0 accounts found — check program ID or discriminator.");
    process.exit(1);
  }

  const allPubkeys = allAccounts.map(a => a.pubkey);
  const pubkeys = SAMPLE > 0
    ? allPubkeys.sort(() => Math.random() - 0.5).slice(0, SAMPLE)
    : allPubkeys;
  console.log(`Checking: ${pubkeys.length.toLocaleString()}${SAMPLE > 0 ? ` (sample of ${SAMPLE})` : ""} accounts\n`);

  let results: Results = {};
  if (RESUME_PATH && fs.existsSync(RESUME_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    results = saved.results ?? {};
    console.log(`Resuming from ${Object.keys(results).length} already checked accounts`);
  }

  _results       = results;
  _totalAccounts = totalAccounts;

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

      const conn = connections[idx % connections.length];
      let status: Status = "error";
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          status = await checkAccount(conn, pk);
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

      if (done % 500 === 0) {
        const inactiveKeys = Object.entries(results)
          .filter(([, s]) => s === "inactive" || s === "new")
          .map(([k]) => k);
        saveResults(results, totalAccounts, inactiveKeys, OBLIGATION_SIZE);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const inactiveKeys = Object.entries(results)
    .filter(([, s]) => s === "inactive" || s === "new")
    .map(([k]) => k);

  saveResults(results, totalAccounts, inactiveKeys, OBLIGATION_SIZE);
  printSummary(results, totalAccounts, OBLIGATION_SIZE);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _totalAccounts = 0;

function onExit() {
  const inactiveKeys = Object.entries(_results)
    .filter(([, s]) => s === "inactive" || s === "new")
    .map(([k]) => k);
  saveResults(_results, _totalAccounts, inactiveKeys, OBLIGATION_SIZE);
  printSummary(_results, _totalAccounts, OBLIGATION_SIZE);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
