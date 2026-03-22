/**
 * Standalone limit probe — runs independently of the main benchmark suite.
 * Measures actual CU consumed by compressStoredChunkedLarge at increasing
 * account sizes to find the single-transaction compression ceiling.
 *
 * Run with:
 *   anchor test --skip-local-validator -- --grep "limit"
 * (requires a running localnet: `solana-test-validator` in another terminal)
 *
 * Or just: anchor test (will run alongside the main suite)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CompressBench } from "../target/types/compress_bench";
import { Keypair, SystemProgram, ComputeBudgetProgram, Connection, Transaction } from "@solana/web3.js";

const MAX_CU = 1_400_000;
const CHUNK_SIZE = 900; // bytes per appendRawLarge call

// Orderbook pattern: 80-byte struct (price f64 + qty f64 + side u8 + 63 zero bytes)
// This is the most compressible realistic data — gives worst-case CU (most chunks filled)
function orderbook(size: number): Buffer {
  const buf = Buffer.alloc(size, 0);
  for (let i = 0; i + 80 <= size; i += 80) {
    buf.writeBigUInt64LE(BigInt("4607632778762754458"), i);     // price ~1000.0
    buf.writeBigUInt64LE(BigInt("4607632778762754458"), i + 8); // qty
    buf[i + 16] = 0x01;                                         // side
    // bytes 17-79: already zero from alloc
  }
  return buf;
}

// Single-signer tx helper — avoids provider.wallet bloating tx with a 2nd signature
async function sendTx(connection: Connection, builder: any, payer: Keypair): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const tx: Transaction = await builder.transaction();
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const result = await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, "confirmed");
  if (result.value.err) throw new Error(JSON.stringify(result.value.err));
  return sig;
}

async function fundedPayer(connection: anchor.web3.Connection): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

async function createStore(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  payer: Keypair
): Promise<Keypair> {
  const store = Keypair.generate();
  const builder = program.methods
    .initStore()
    .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId });
  const latestBlockhash = await provider.connection.getLatestBlockhash("confirmed");
  const tx: Transaction = await builder.transaction();
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, store);
  const sig = await provider.connection.sendRawTransaction(tx.serialize());
  const result = await provider.connection.confirmTransaction({ signature: sig, ...latestBlockhash }, "confirmed");
  if (result.value.err) throw new Error(JSON.stringify(result.value.err));
  return store;
}

async function uploadLarge(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  store: Keypair,
  data: Buffer,
  payer: Keypair
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    const builder = program.methods
      .appendRawLarge(chunk)
      .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
    await sendTx(provider.connection, builder, payer);
  }
}

// ── Multi-tx compression helper ────────────────────────────────────────────────
// Compresses an already-uploaded large account using init → batches → finalize.
// Returns { rawBytes, compBytes, cuTotal, txCount }.
async function compressMultiTx(
  program: Program<CompressBench>,
  provider: anchor.AnchorProvider,
  store: Keypair,
  payer: Keypair,
  rawBytes: number
): Promise<{ compBytes: number; cuTotal: number; txCount: number }> {
  const BATCH_CHUNKS = 38; // max chunks per batch — 38×~35kCU ≈ 1.33M, safe under 1.4M limit
  const chunk_count = Math.ceil(rawBytes / 4096);
  const header_len = 9 + chunk_count * 8;
  const dangerous_count = Math.ceil(header_len / 4096);

  let cuTotal = 0;
  let txCount = 0;

  async function getTxCu(sig: string): Promise<number> {
    const tx = await provider.connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    return tx?.meta?.computeUnitsConsumed ?? 0;
  }

  // Step 1: init
  const initBuilder = program.methods
    .compressLargeInit()
    .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
  const initSig = await sendTx(provider.connection, initBuilder, payer);
  cuTotal += await getTxCu(initSig);
  txCount++;

  // Read write_offset from init logs
  const initTx = await provider.connection.getTransaction(initSig, {
    maxSupportedTransactionVersion: 0, commitment: "confirmed",
  });
  const initLog = (initTx?.meta?.logMessages ?? []).find(l => l.includes("compress_large_init"));
  let writeOffset = parseInt(initLog!.match(/write_offset=(\d+)/)![1]);

  // Step 2: batches for remaining chunks (after dangerous ones handled by init)
  let firstChunk = dangerous_count;
  while (firstChunk < chunk_count) {
    const numChunks = Math.min(BATCH_CHUNKS, chunk_count - firstChunk);
    const batchBuilder = program.methods
      .compressLargeBatch(firstChunk, numChunks, writeOffset)
      .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
    const batchSig = await sendTx(provider.connection, batchBuilder, payer);
    cuTotal += await getTxCu(batchSig);
    txCount++;

    const batchTx = await provider.connection.getTransaction(batchSig, {
      maxSupportedTransactionVersion: 0, commitment: "confirmed",
    });
    const batchLog = (batchTx?.meta?.logMessages ?? []).find(l => l.includes("compress_large_batch"));
    writeOffset = parseInt(batchLog!.match(/new_write_offset=(\d+)/)![1]);
    firstChunk += numChunks;
  }

  // Step 3: finalize — total compressed len = full ChunkedLz4 payload (header+index+blocks)
  const totalCompressedLen = writeOffset - 12;
  const finalizeBuilder = program.methods
    .compressLargeFinalize(totalCompressedLen)
    .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId });
  const finSig = await sendTx(provider.connection, finalizeBuilder, payer);
  cuTotal += await getTxCu(finSig);
  txCount++;

  return { compBytes: totalCompressedLen, cuTotal, txCount };
}

describe("COMPRESSION LIMIT PROBE", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CompressBench as Program<CompressBench>;

  // Sizes to probe: multiples of 4096 (chunk size), bracketing the expected ~168 KB limit
  // 90 KB (known baseline) + 4 sizes above it
  const PROBE_SIZES = [
    { bytes: 90_952,  label: "90 KB (baseline)" },
    { bytes: 32 * 4096, label: "128 KB (32 chunks)" },   // 131,072 — expect ~1.06M CU ✓
    { bytes: 40 * 4096, label: "160 KB (40 chunks)" },   // 163,840 — expect ~1.33M CU ✓
    { bytes: 42 * 4096, label: "168 KB (42 chunks)" },   // 172,032 — expect ~1.40M CU ≈ limit
    { bytes: 44 * 4096, label: "176 KB (44 chunks)" },   // 180,224 — expect ~1.46M CU ✗
    { bytes: 48 * 4096, label: "192 KB (48 chunks)" },   // 196,608 — expect ~1.59M CU ✗
  ];

  console.log("\n=== SINGLE-TX COMPRESSION LIMIT PROBE ===");
  console.log("(orderbook-pattern data, compressStoredChunkedLarge)");
  console.log(
    "label".padEnd(24),
    "bytes".padStart(10),
    "chunks".padStart(8),
    "CU used".padStart(12),
    "result".padStart(10)
  );

  // ── Multi-tx large account compression ───────────────────────────────────────
  const LARGE_SIZES = [
    { bytes: 1 * 1024 * 1024,  label: "1 MB (256 chunks)" },
    { bytes: 4 * 1024 * 1024,  label: "4 MB (1024 chunks)" },
    { bytes: 10 * 1024 * 1024, label: "10 MB (2560 chunks) — Solana max" },
  ];

  console.log("\n=== MULTI-TX LARGE ACCOUNT COMPRESSION ===");
  console.log("(orderbook-pattern data, multi-tx compressLargeInit/Batch/Finalize)");
  console.log(
    "label".padEnd(34),
    "raw B".padStart(12),
    "comp B".padStart(10),
    "ratio".padStart(8),
    "total CU".padStart(12),
    "txs".padStart(6),
    "rent saved".padStart(12)
  );

  for (const { bytes, label } of LARGE_SIZES) {
    it(label, async function () {
      this.timeout(7_200_000); // 2 hours — upload is slow

      const payer = await fundedPayer(provider.connection);
      const store = await createStore(program, provider, payer);

      process.stdout.write(`  uploading ${label}...`);
      await uploadLarge(program, provider, store, orderbook(bytes), payer);
      process.stdout.write(` done. compressing...`);

      const { compBytes, cuTotal, txCount } = await compressMultiTx(
        program, provider, store, payer, bytes
      );

      const ratio = bytes / compBytes;
      const lamportsPerByte = 3480 * 2;
      const rentSaved = (bytes - compBytes) * lamportsPerByte;
      const solSaved = rentSaved / 1e9;

      console.log(
        `\n${label.padEnd(34)}`,
        String(bytes).padStart(12),
        String(compBytes).padStart(10),
        ratio.toFixed(2).padStart(7) + "×",
        cuTotal.toLocaleString("en").padStart(12),
        String(txCount).padStart(6),
        `~${solSaved.toFixed(2)} SOL`.padStart(12)
      );
    });
  }

  // ── Per-size single-tx ceiling probe ──────────────────────────────────────────
  for (const { bytes, label } of PROBE_SIZES) {
    it(label, async function () {
      this.timeout(300_000);

      const payer = await fundedPayer(provider.connection);
      const store = await createStore(program, provider, payer);
      await uploadLarge(program, provider, store, orderbook(bytes), payer);

      // Build tx manually (single signer) to avoid provider wallet bloating tx size over 1232 bytes
      let sig: string | null = null;
      try {
        const builder = program.methods
          .compressStoredChunkedLarge()
          .accounts({ store: store.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU })]);
        const latestBlockhash = await provider.connection.getLatestBlockhash("confirmed");
        const tx = await builder.transaction();
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        const rawSig = await provider.connection.sendRawTransaction(tx.serialize());
        const result = await provider.connection.confirmTransaction(
          { signature: rawSig, ...latestBlockhash },
          "confirmed"
        );
        if (result.value.err) throw new Error(JSON.stringify(result.value.err));
        sig = rawSig;
      } catch (e: any) {
        console.log(`  ${label}: TX FAILED — ${e.message?.slice(0,80)}`);
      }

      if (!sig) return;

      const tx = await provider.connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const cu = tx?.meta?.computeUnitsConsumed ?? null;
      const ok = cu !== null && cu <= MAX_CU;

      console.log(
        label.padEnd(24),
        String(bytes).padStart(10),
        String(Math.ceil(bytes / 4096)).padStart(8),
        (cu !== null ? cu.toLocaleString("en") : "null").padStart(12),
        ok ? "✓ fits" : "✗ over limit"
      );
    });
  }
});
