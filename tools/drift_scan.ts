/**
 * drift_scan.ts — count inactive Drift User accounts (no tx in last N days).
 *
 * Usage:
 *   RPC_URL=https://... yarn ts-node --transpile-only tools/drift_scan.ts
 *
 * Env vars:
 *   RPC_URL        — Solana RPC endpoint (default: mainnet public, slow)
 *   INACTIVE_DAYS  — days without activity (default: 30)
 *   CONCURRENCY    — parallel RPC requests (default: 10, raise with private RPC)
 *   LIMIT          — max accounts to check, 0 = all (default: 0)
 *   RESUME         — path to partial results JSON to resume from (optional)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
const DRIFT_USER_SIZE = 4376;

const RPC_URL     = process.env.RPC_URL     ?? "https://api.mainnet-beta.solana.com";
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS  ?? "30");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "10");
const LIMIT       = Number(process.env.LIMIT       ?? "0");
const RESUME_PATH = process.env.RESUME;
const SAVE_PATH   = "tools/drift_scan_results.json";

const cutoffSec = Math.floor(Date.now() / 1000) - INACTIVE_DAYS * 24 * 3600;

async function checkAccount(
  connection: Connection,
  pubkey: PublicKey
): Promise<"inactive" | "active" | "new"> {
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1 });
  if (sigs.length === 0) return "new";
  const lastBlockTime = sigs[0].blockTime ?? 0;
  return lastBlockTime < cutoffSec ? "inactive" : "active";
}

async function runBatch(
  connection: Connection,
  pubkeys: PublicKey[],
  results: Record<string, "inactive" | "active" | "new">
): Promise<void> {
  let i = 0;
  let active = 0, inactive = 0, fresh = 0, errors = 0;

  // recount from already saved results
  for (const v of Object.values(results)) {
    if (v === "active")   active++;
    if (v === "inactive") inactive++;
    if (v === "new")      fresh++;
  }

  const total = pubkeys.length;

  async function worker(id: number) {
    while (true) {
      const idx = i++;
      if (idx >= total) break;
      const pk = pubkeys[idx];
      const key = pk.toBase58();
      if (results[key]) continue; // already done (resume)

      try {
        const status = await checkAccount(connection, pk);
        results[key] = status;
        if (status === "active")   active++;
        if (status === "inactive") inactive++;
        if (status === "new")      fresh++;
      } catch {
        errors++;
        i--; // retry
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const done = active + inactive + fresh;
      const pct = ((done / total) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] checked=${done}/${total}  inactive=${inactive}  active=${active}  never_used=${fresh}  errors=${errors}`
      );

      // save every 500 accounts
      if (done % 500 === 0) {
        fs.writeFileSync(SAVE_PATH, JSON.stringify({ cutoffDays: INACTIVE_DAYS, results }, null, 2));
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, id) => worker(id));
  await Promise.all(workers);
}

function printSummary(
  results: Record<string, "inactive" | "active" | "new">,
  total: number
) {
  const counts = { inactive: 0, active: 0, new: 0 };
  for (const v of Object.values(results)) counts[v]++;
  const done = counts.inactive + counts.active + counts.new;
  const pct = (n: number) =>
    done > 0 ? `${((n / done) * 100).toFixed(1)}%` : "n/a";

  console.log("\n\n=== RESULTS ===");
  console.log(`Total accounts:       ${total.toLocaleString()}`);
  console.log(`Checked so far:       ${done.toLocaleString()}`);
  console.log(
    `Active (tx in last ${INACTIVE_DAYS}d):   ${counts.active.toLocaleString()}  (${pct(counts.active)})`
  );
  console.log(
    `Inactive (stale >${INACTIVE_DAYS}d):     ${counts.inactive.toLocaleString()}  (${pct(counts.inactive)})`
  );
  console.log(`Never used:           ${counts.new.toLocaleString()}  (${pct(counts.new)})`);
  console.log(`\nResults saved to: ${SAVE_PATH}`);
  console.log(`Resume: RESUME=${SAVE_PATH} yarn ts-node --transpile-only tools/drift_scan.ts`);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`RPC:          ${RPC_URL}`);
  console.log(
    `Inactive if:  no tx in last ${INACTIVE_DAYS} days (or last tx older)`
  );
  console.log(`Concurrency:  ${CONCURRENCY} parallel requests`);
  console.log();

  console.log("Fetching all Drift User accounts...");
  const all = await connection.getProgramAccounts(DRIFT_PROGRAM_ID, {
    filters: [{ dataSize: DRIFT_USER_SIZE }],
    dataSlice: { offset: 0, length: 0 },
  });

  const pubkeys = (LIMIT > 0 ? all.slice(0, LIMIT) : all).map((a) => a.pubkey);
  console.log(`Total accounts found: ${pubkeys.length.toLocaleString()}`);
  console.log(`Checking last transaction for each...\n`);

  // load resume file if provided (scan all pubkeys; skip keys already in results)
  let results: Record<string, "inactive" | "active" | "new"> = {};

  if (RESUME_PATH && fs.existsSync(RESUME_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    results = saved.results ?? {};
    const n = Object.keys(results).length;
    console.log(`Resuming with ${n.toLocaleString()} accounts already in results`);
  }

  _results = results;
  _total = pubkeys.length;

  await runBatch(connection, pubkeys, results);

  // final save + summary
  fs.writeFileSync(SAVE_PATH, JSON.stringify({ cutoffDays: INACTIVE_DAYS, results }, null, 2));
  printSummary(results, pubkeys.length);
}

let _results: Record<string, "inactive" | "active" | "new"> = {};
let _total = 0;

process.on("SIGINT", () => {
  fs.writeFileSync(SAVE_PATH, JSON.stringify({ cutoffDays: INACTIVE_DAYS, results: _results }, null, 2));
  printSummary(_results, _total);
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("\nCrash:", err.message);
  fs.writeFileSync(SAVE_PATH, JSON.stringify({ cutoffDays: INACTIVE_DAYS, results: _results }, null, 2));
  printSummary(_results, _total);
  process.exit(1);
});

main().catch((err) => {
  console.error("\nError:", err.message);
  fs.writeFileSync(SAVE_PATH, JSON.stringify({ cutoffDays: INACTIVE_DAYS, results: _results }, null, 2));
  printSummary(_results, _total);
  process.exit(1);
});
