/**
 * densol live demo script
 *
 * MODES
 *   yarn demo:setup   — pre-populate a 90 KB raw orderbook account on devnet
 *                       (run once, ~2 min, before the presentation)
 *   yarn demo         — load the pre-populated account, show stats, wait for
 *                       Enter, compress on-chain in one tx, show savings
 *
 * PREREQUISITE
 *   1. anchor build && anchor deploy --provider.cluster devnet
 *   2. Update PROGRAM_ID below with the deployed address
 *   3. yarn demo:setup
 *   4. yarn demo   (live, during the presentation)
 */

import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const IS_LOCAL = (process.env.CLUSTER ?? "devnet") === "local";

/**
 * Localnet program ID (from Anchor.toml [programs.localnet]).
 * For devnet: update DEVNET_PROGRAM_ID after `anchor deploy --provider.cluster devnet`.
 */
const LOCALNET_PROGRAM_ID = "AwLfrSLLSDht8b59VmyVhLGSg5vgdKyWMseKQpjSohKM";
const DEVNET_PROGRAM_ID   = "AwLfrSLLSDht8b59VmyVhLGSg5vgdKyWMseKQpjSohKM";

const PROGRAM_ID   = IS_LOCAL ? LOCALNET_PROGRAM_ID : DEVNET_PROGRAM_ID;
const RPC          = IS_LOCAL ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com";
const CHUNK_SIZE   = 900;        // bytes per appendRawLarge tx
const MAX_CU       = 1_400_000;
const DATA_SIZE    = 90_952;     // OpenBook BookSide payload bytes
const ACCOUNT_FILE = path.join(__dirname, IS_LOCAL ? "account.local.json" : "account.json");

// ── Data generator ────────────────────────────────────────────────────────────

/**
 * 80-byte orderbook entries: price(f64 LE) + qty(f64 LE) + side(1 B) + 63 zeros.
 * Same pattern as the real OpenBook SOL/USDC BookSide — compresses ~53×.
 */
function orderbookData(size: number): Buffer {
  const entry = Buffer.alloc(80);
  entry.writeDoubleLE(1234.5678, 0);
  entry.writeDoubleLE(100.0, 8);
  entry[16] = 0x01; // side: bid; bytes 17-79 already zero
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = entry[i % 80];
  return out;
}

// ── Display helpers ───────────────────────────────────────────────────────────

const SOL  = (lam: number) => (lam / LAMPORTS_PER_SOL).toFixed(6);
const USD  = (lam: number, price: number) =>
  ((lam / LAMPORTS_PER_SOL) * price).toFixed(2);
const LINE = "━".repeat(50);

function banner(title: string) {
  console.log(`\n${LINE}`);
  console.log(`  ${title}`);
  console.log(LINE);
}

function accountExplorerUrl(pubkey: string): string {
  if (IS_LOCAL) {
    const custom = encodeURIComponent("http://localhost:8899");
    return `https://explorer.solana.com/address/${pubkey}?cluster=custom&customUrl=${custom}`;
  }
  return `https://solscan.io/account/${pubkey}?cluster=devnet`;
}

async function fetchSolPrice(): Promise<number> {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      (res) => {
        let body = "";
        res.on("data", (d: string) => (body += d));
        res.on("end", () => {
          try {
            resolve((JSON.parse(body) as any).solana?.usd ?? 200);
          } catch {
            resolve(200);
          }
        });
      }
    );
    req.on("error", () => resolve(200));
    setTimeout(() => resolve(200), 3_000);
  });
}

function pressEnter(msg: string): Promise<void> {
  process.stdout.write(`\n  ${msg}`);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// ── Transaction helper ────────────────────────────────────────────────────────

async function sendTx(
  connection: Connection,
  builder: any,
  payer: Keypair
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx: Transaction = await builder.transaction();
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const result = await connection.confirmTransaction(
        { signature: sig, ...latest },
        "confirmed"
      );
      if (result.value.err) {
        throw new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
      }
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

// ── Shared bootstrap ──────────────────────────────────────────────────────────

function loadWallet(): Keypair {
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")))
  );
}

function loadProgram(
  connection: Connection,
  walletKp: Keypair
): Program {
  const idlPath = path.join(
    __dirname,
    "../target/idl/compress_bench.json"
  );
  // In Anchor 0.32 the constructor is new Program(idl, provider?) — program ID
  // comes from idl.address.  Patch it here so devnet deployments work too.
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as any;
  idl.address = PROGRAM_ID;
  const wallet = new anchor.Wallet(walletKp);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  return new Program(idl, provider);
}

// ── SETUP mode ────────────────────────────────────────────────────────────────

async function setup() {
  banner("densol DEMO SETUP — creating 90 KB orderbook account on devnet");

  const connection = new Connection(RPC, "confirmed");
  const walletKp = loadWallet();
  console.log(`  Wallet   : ${walletKp.publicKey.toBase58()}`);

  // Ensure sufficient balance
  let balance = await connection.getBalance(walletKp.publicKey);
  if (balance < 1.2 * LAMPORTS_PER_SOL) {
    console.log("  Balance low — requesting devnet airdrop...");
    const sig = await connection.requestAirdrop(
      walletKp.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");
    balance = await connection.getBalance(walletKp.publicKey);
  }
  console.log(`  Balance  : ${SOL(balance)} SOL`);

  const program = loadProgram(connection, walletKp);

  // Init the store account (space = 8 discriminator + 4 length field)
  const store = Keypair.generate();
  console.log(`\n  Creating account...`);
  await (program.methods as any)
    .initStore()
    .accounts({
      store: store.publicKey,
      payer: walletKp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([store])
    .rpc();
  console.log(`  Account  : ${store.publicKey.toBase58()}`);

  // Upload orderbook data via appendRawLarge in CHUNK_SIZE batches
  const data = orderbookData(DATA_SIZE);
  const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
  console.log(
    `\n  Uploading ${(DATA_SIZE / 1024).toFixed(1)} KB in ${totalChunks} chunks...`
  );

  for (let i = 0, offset = 0; offset < data.length; i++, offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    process.stdout.write(`\r  Progress : ${i + 1} / ${totalChunks}   `);
    const builder = (program.methods as any)
      .appendRawLarge(chunk)
      .accounts({
        store: store.publicKey,
        payer: walletKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
      ]);
    await sendTx(connection, builder, walletKp);
  }
  process.stdout.write(`\r  Progress : ${totalChunks} / ${totalChunks} done\n`);

  // Read final on-chain state
  const accountInfo = await connection.getAccountInfo(store.publicKey);
  const accountSize = accountInfo!.data.length;
  const rent = await connection.getMinimumBalanceForRentExemption(accountSize);

  // Persist keypair so the demo script can load it later
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(Array.from(store.secretKey)));

  banner("READY");
  console.log(`  Account  : ${store.publicKey.toBase58()}`);
  console.log(`  Size     : ${accountSize.toLocaleString()} bytes`);
  console.log(`  Rent     : ${SOL(rent)} SOL`);
  const explorerUrl = accountExplorerUrl(store.publicKey.toBase58());
  console.log(`  Explorer : ${explorerUrl}`);
  const demoCmd = IS_LOCAL ? "yarn demo:local" : "yarn demo";
  console.log(`\n  Run  ${demoCmd}  to start the live presentation.\n`);
}

// ── DEMO mode ─────────────────────────────────────────────────────────────────

async function demo() {
  if (!fs.existsSync(ACCOUNT_FILE)) {
    console.error(
      `\n  Error: ${path.basename(ACCOUNT_FILE)} not found.\n  Run \`${IS_LOCAL ? "yarn demo:local:setup" : "yarn demo:setup"}\` first.\n`
    );
    process.exit(1);
  }

  const connection = new Connection(RPC, "confirmed");
  const walletKp  = loadWallet();
  const storeKp   = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8")))
  );
  const pubkey      = storeKp.publicKey.toBase58();
  const explorerUrl = accountExplorerUrl(pubkey);

  // Fetch live SOL price — best effort, fallback $200 (skipped for local)
  const solPrice = IS_LOCAL ? 200 : await fetchSolPrice();

  // Read current (raw) account state
  const rawInfo = await connection.getAccountInfo(storeKp.publicKey);
  if (!rawInfo) {
    console.error(
      `\n  Error: account not found on ${IS_LOCAL ? "localnet" : "devnet"}. Re-run setup.\n`
    );
    process.exit(1);
  }
  const rawSize    = rawInfo.data.length;
  const rawRent    = await connection.getMinimumBalanceForRentExemption(rawSize);
  const walletBefore = await connection.getBalance(walletKp.publicKey);

  // ── BEFORE ───────────────────────────────────────────────────────────────
  banner("densol LIVE DEMO — OpenBook orderbook account");
  console.log(`\nBEFORE  (standard Anchor account)`);
  console.log(`  Account  : ${pubkey}`);
  console.log(`  Size     : ${rawSize.toLocaleString()} bytes`);
  console.log(
    `  Rent     : ${SOL(rawRent)} SOL  (~$${USD(rawRent, solPrice)} at $${Math.round(solPrice)}/SOL)`
  );
  console.log(`  Wallet   : ${SOL(walletBefore)} SOL`);
  console.log(`  Explorer : ${explorerUrl}`);

  const openPrompt = IS_LOCAL
    ? "Open Explorer ↑, then press Enter to compress on-chain..."
    : "Open Solscan ↑, then press Enter to compress on-chain...";
  await pressEnter(openPrompt);

  // ── COMPRESS ─────────────────────────────────────────────────────────────
  console.log(`\n  Compressing 90 KB on-chain with ChunkedLz4...`);

  const program = loadProgram(connection, walletKp);
  const sig = await sendTx(
    connection,
    (program.methods as any)
      .compressStoredChunkedLarge()
      .accounts({
        store: storeKp.publicKey,
        payer: walletKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
      ]),
    walletKp
  );
  console.log(`  Tx       : ${sig}`);

  // Read compressed on-chain state
  const compInfo     = await connection.getAccountInfo(storeKp.publicKey);
  const compSize     = compInfo!.data.length;
  const compRent     = await connection.getMinimumBalanceForRentExemption(compSize);
  const walletAfter  = await connection.getBalance(walletKp.publicKey);
  const ratio        = (rawSize / compSize).toFixed(1);
  const rentSaved    = rawRent - compRent;
  const walletDelta  = walletAfter - walletBefore;

  // ── AFTER ────────────────────────────────────────────────────────────────
  console.log(`\nAFTER   (#[derive(Compress)] + #[compress])`);
  console.log(`  Account  : ${pubkey}  (same address)`);
  console.log(`  Size     : ${compSize.toLocaleString()} bytes   (${ratio}× smaller)`);
  console.log(
    `  Rent     : ${SOL(compRent)} SOL  (~$${USD(compRent, solPrice)})`
  );
  console.log(
    `  Wallet   : ${SOL(walletAfter)} SOL  (${walletDelta >= 0 ? "+" : ""}${SOL(walletDelta)} SOL)`
  );
  console.log(`  Explorer : ${explorerUrl}`);

  console.log(`\n${LINE}`);
  console.log(`  RENT FREED PER ACCOUNT  ${SOL(rentSaved)} SOL  (~$${USD(rentSaved, solPrice)})`);
  const at1k  = rentSaved * 1_000;
  const at10k = rentSaved * 10_000;
  console.log(
    `  At   1,000 accounts     ${SOL(at1k)} SOL  (~$${USD(at1k, solPrice)})`
  );
  console.log(
    `  At  10,000 accounts     ${SOL(at10k)} SOL  (~$${USD(at10k, solPrice)})`
  );
  console.log(LINE);
  const kbGone = ((rawSize - compSize) / 1024).toFixed(0);
  console.log(`\n  Refresh Solscan — same account, ${kbGone} KB gone.\n`);
}

// ── READ mode ─────────────────────────────────────────────────────────────────

/**
 * Minimal LZ4 block decompressor — standard spec, no third-party dependency.
 * Compatible with lz4_flex::block::decompress_size_prepended output.
 *
 * src: raw LZ4 block bytes (WITHOUT the 4-byte size prefix)
 * outputSize: expected decompressed length
 */
function decompressLz4Block(src: Buffer, outputSize: number): Buffer {
  const dst = Buffer.allocUnsafe(outputSize);
  let sIdx = 0;
  let dIdx = 0;

  while (sIdx < src.length) {
    const token = src[sIdx++];

    // Literal run length (upper nibble; 15 = extend)
    let litLen = (token >>> 4) & 0xf;
    if (litLen === 0xf) {
      let b: number;
      do { b = src[sIdx++]; litLen += b; } while (b === 0xff);
    }
    for (let i = 0; i < litLen; i++) dst[dIdx++] = src[sIdx++];

    if (sIdx >= src.length) break; // last sequence has no match

    // Match offset (16-bit LE)
    const matchOffset = src[sIdx] | (src[sIdx + 1] << 8);
    sIdx += 2;

    // Match length (lower nibble + MINMATCH=4; 15 = extend)
    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 0xf) {
      let b: number;
      do { b = src[sIdx++]; matchLen += b; } while (b === 0xff);
    }

    // Copy match byte-by-byte to handle overlapping runs
    let mSrc = dIdx - matchOffset;
    for (let i = 0; i < matchLen; i++) dst[dIdx++] = dst[mSrc++];
  }

  return dst.slice(0, dIdx);
}

/**
 * Decompress a ChunkedLz4 payload entirely client-side.
 *
 * Wire layout (after 0x02 discriminant byte):
 *   [chunk_count: u32 LE][original_len: u32 LE]
 *   [index: chunk_count × (offset: u32 LE, compressed_len: u32 LE)]
 *   [data region: concatenated lz4_flex prepend_size blocks]
 *
 * Each block: [decompressed_len: 4B LE][LZ4 raw block...]
 */
function decompressChunkedLz4(payload: Buffer): Buffer {
  const chunkCount   = payload.readUInt32LE(1);
  const originalLen  = payload.readUInt32LE(5);
  const indexBase    = 9; // 1 (discriminant) + 4 (chunk_count) + 4 (original_len)
  const dataRegionStart = indexBase + chunkCount * 8;

  const out = Buffer.allocUnsafe(originalLen);
  let writeOffset = 0;

  for (let i = 0; i < chunkCount; i++) {
    const entryBase    = indexBase + i * 8;
    const blockOffset  = payload.readUInt32LE(entryBase);
    const blockCompLen = payload.readUInt32LE(entryBase + 4);

    const blockStart     = dataRegionStart + blockOffset;
    const block          = payload.slice(blockStart, blockStart + blockCompLen);
    const decompChunkLen = block.readUInt32LE(0); // lz4_flex prepend_size prefix
    const chunk          = decompressLz4Block(block.slice(4), decompChunkLen);

    chunk.copy(out, writeOffset);
    writeOffset += chunk.length;
  }

  return out.slice(0, writeOffset);
}

async function read() {
  if (!fs.existsSync(ACCOUNT_FILE)) {
    console.error(
      `\n  Error: ${path.basename(ACCOUNT_FILE)} not found.\n  Run \`${IS_LOCAL ? "yarn demo:local:setup" : "yarn demo:setup"}\` first.\n`
    );
    process.exit(1);
  }

  const connection = new Connection(RPC, "confirmed");
  const storeKp    = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8")))
  );

  const info = await connection.getAccountInfo(storeKp.publicKey);
  if (!info) {
    console.error(`\n  Error: account not found on ${IS_LOCAL ? "localnet" : "devnet"}.\n`);
    process.exit(1);
  }

  // Account layout: [8B discriminator][4B vec-len LE][payload bytes]
  const payload      = Buffer.from(info.data.slice(12));
  const isCompressed = payload.length > 0 && payload[0] === 0x02;

  const decompressed = isCompressed ? decompressChunkedLz4(payload) : payload;
  const sha256       = crypto.createHash("sha256").update(decompressed).digest("hex");

  banner("densol DEMO — account checksum");
  console.log(`\n  Format   : ${isCompressed ? "ChunkedLz4 (decompressed client-side)" : "raw"}`);
  console.log(`  Data     : ${decompressed.length.toLocaleString()} bytes`);
  console.log(`  SHA-256  : ${sha256}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === "setup") {
  setup().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (mode === "read") {
  read().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  demo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
