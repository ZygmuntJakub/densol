/**
 * scan.ts — count inactive Drift User accounts (no tx in last N days).
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only benchmark/drift/scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10, raise with private RPC)
 *   SAMPLE         — random sample size, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
const DRIFT_USER_SIZE = 4376;

// Anchor discriminator = sha256("account:User")[0..8], base58-encoded
const USER_DISCRIMINATOR_B58 = utils.bytes.bs58.encode(
  createHash("sha256").update("account:User").digest().slice(0, 8)
);

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function checkAccount(
  connection: Connection,
  pubkey: PublicKey
): Promise<Status> {
  const sigs = await withTimeout(
    connection.getSignaturesForAddress(pubkey, { limit: 1 }),
    RPC_TIMEOUT_MS
  );

  if (sigs.length === 0) return "new";

  // blockTime can be null for very recent txs — treat as active (tx just happened)
  if (sigs[0].blockTime === null) return "active";

  return sigs[0].blockTime < cutoffSec ? "inactive" : "active";
}

function printSummary(results: Results, totalOnMainnet: number) {
  const counts = { inactive: 0, active: 0, new: 0, error: 0 };
  for (const v of Object.values(results)) counts[v as keyof typeof counts]++;
  const done = counts.inactive + counts.active + counts.new + counts.error;

  console.log("\n\n=== RESULTS ===");
  console.log(`Total on mainnet:     ${totalOnMainnet.toLocaleString()}`);
  console.log(`Checked:              ${done.toLocaleString()}`);
  console.log(`Active:               ${counts.active.toLocaleString()}  (${done ? ((counts.active / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Inactive (>${INACTIVE_DAYS}d):    ${counts.inactive.toLocaleString()}  (${done ? ((counts.inactive / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Never used:           ${counts.new.toLocaleString()}  (${done ? ((counts.new / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Errors (skipped):     ${counts.error.toLocaleString()}`);

  const reliable = done - counts.error;
  if (reliable > 0 && totalOnMainnet > done) {
    const rate = counts.inactive / reliable;
    const est  = Math.round(totalOnMainnet * rate);
    console.log(`\nExtrapolated inactive: ~${est.toLocaleString()} of ${totalOnMainnet.toLocaleString()} total`);
  }

  console.log(`\nResults saved to: ${SAVE_PATH}`);
  console.log(`Next step: yarn ts-node --transpile-only benchmark/drift/savings.ts`);
}

function saveResults(results: Results, totalOnMainnet: number) {
  fs.writeFileSync(SAVE_PATH, JSON.stringify({
    scannedAt:      new Date().toISOString(),
    cutoffDays:     INACTIVE_DAYS,
    totalOnMainnet,
    sample:         SAMPLE,
    results,
  }, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`RPC:           ${RPC_URL}`);
  console.log(`Inactive if:   no tx in >${INACTIVE_DAYS} days`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Sample:        ${SAMPLE === 0 ? "all" : SAMPLE}`);
  console.log(`Discriminator: ${USER_DISCRIMINATOR_B58}`);
  console.log();

  console.log("Fetching all Drift User accounts...");
  const all = await connection.getProgramAccounts(DRIFT_PROGRAM_ID, {
    filters: [
      { dataSize: DRIFT_USER_SIZE },
      { memcmp: { offset: 0, bytes: USER_DISCRIMINATOR_B58 } },
    ],
    dataSlice: { offset: 0, length: 0 },
  });

  const totalOnMainnet = all.length;
  console.log(`Total on mainnet: ${totalOnMainnet.toLocaleString()}`);

  // shuffle to avoid pubkey-order bias, then optionally sample
  const pubkeys = shuffle(all.map((a) => a.pubkey));
  const target  = SAMPLE > 0 ? pubkeys.slice(0, SAMPLE) : pubkeys;
  console.log(`Checking: ${target.length.toLocaleString()} accounts\n`);

  // load resume data if provided
  let results: Results = {};
  if (RESUME_PATH && fs.existsSync(RESUME_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    results = saved.results ?? {};
    console.log(`Resuming from ${Object.keys(results).length} already checked accounts`);
  }

  // expose to signal handlers
  _results = results;
  _total   = totalOnMainnet;

  // recount from resumed results
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
      if (idx >= target.length) break;
      const pk  = target[idx];
      const key = pk.toBase58();
      if (results[key]) continue; // already done (resume)

      let status: Status = "error";
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          status = await checkAccount(connection, pk);
          break;
        } catch (e) {
          if (attempt < MAX_RETRIES - 1) {
            // exponential backoff: 1s, 2s, 4s, 8s
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
      }

      results[key] = status;
      if (status === "active")   active++;
      if (status === "inactive") inactive++;
      if (status === "new")      fresh++;
      if (status === "error")    errors++;

      const done = active + inactive + fresh + errors;
      const pct  = ((done / target.length) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] checked=${done}/${target.length}  inactive=${inactive}  active=${active}  never_used=${fresh}  errors=${errors}`
      );

      if (done % 500 === 0) saveResults(results, totalOnMainnet);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  saveResults(results, totalOnMainnet);
  printSummary(results, totalOnMainnet);
}

// ── Signal handlers ────────────────────────────────────────────────────────────

let _results: Results = {};
let _total   = 0;

function onExit() {
  saveResults(_results, _total);
  printSummary(_results, _total);
}

process.on("SIGINT",            () => { onExit(); process.exit(0); });
process.on("uncaughtException", (e) => { console.error("\nCrash:", e.message); onExit(); process.exit(1); });
main().catch(                   (e) => { console.error("\nError:", e.message); onExit(); process.exit(1); });
