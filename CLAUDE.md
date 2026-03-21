# compress_bench / densol — project context

## What this repo is

A Solana/Anchor benchmark harness for **densol** (`crates/densol`), a Solana-compatible LZ4 compression library. The repo measures compute units (CU) and rent savings for on-chain compression at various data sizes and types, then publishes results in README.md.

## Scope: on-chain only

**This project is exclusively about compression that runs inside a Solana program (on-chain).** Off-chain compression (compress client-side, upload pre-compressed bytes) is out of scope and not interesting — any general-purpose compressor can do that. The value of densol is that it fits within the SBF VM constraints (32 KB heap, no libc, no std allocator) so the program itself can compress and decompress without any client-side involvement.

## Workspace layout

```
crates/densol/          — the library being benchmarked (published to crates.io)
crates/densol-derive/   — proc-macro crate (#[derive(Compress)])
programs/compress_bench/ — Anchor program with all benchmark instructions
tests/compress_bench.ts  — Mocha/Anchor test suite; all benchmarking logic lives here
tools/compress_tool/     — CLI to measure compression of raw account bytes (used for private/real_world.md)
results/benchmark.json   — generated output from anchor test
private/real_world.md    — mainnet account measurements (not committed to public repo)
```

## Key constraints

### SBF heap (32 KB bump-allocated, no free)
- LZ4 hash table is 16 KB on the **stack**, not heap
- Peak heap for plain `Lz4`: ~2× input size (input + output buffer simultaneously)
- Practical in-program ceiling: **~10–12 KB** input for plain Lz4
- `ChunkedLz4<4096>`: splits input into 4 KB chunks; `decompress_chunk(i)` uses only ~4 KB heap — no OOM ceiling on account size

### Anchor deserialization OOM for large accounts
- `Account<DataStore>` Borsh-deserializes the full `Vec<u8>` at instruction entry — heap-allocates the entire stored blob before the instruction body runs
- A 90 KB account OOMs immediately via `Account<DataStore>`
- Fix: use `AccountInfo<'info>` with `data.borrow()` (zero-copy `&[u8]`) for large-account instructions

### Account binary layout (DataStore)
```
bytes 0..8   — Anchor 8-byte discriminator (sha256 of "account:DataStore"[:8])
bytes 8..12  — u32 LE = length of the stored Vec<u8>
bytes 12..   — Vec<u8> payload (raw or compressed)
```
Both `append_raw_large` and `compress_stored_chunked_large` read/write this layout directly via `AccountInfo`.

## Instructions

| Instruction | Account type | Heap peak | Notes |
|---|---|---|---|
| `store_raw` | `Account<DataStore>` | ~2× payload | OOMs above ~12 KB stored |
| `store_compressed` | `Account<DataStore>` | ~2× payload | Lz4 compress+store in one tx |
| `compress_stored` | `Account<DataStore>` | ~2× raw | In-place Lz4; OOMs above ~12 KB |
| `store_chunked` | `Account<DataStore>` | ~2× payload | ChunkedLz4 compress+store |
| `compress_stored_chunked` | `Account<DataStore>` | ~2× raw | In-place ChunkedLz4; same OOM limit |
| `read_raw` | `Account<DataStore>` | ~N | Checksum raw bytes |
| `read_compressed` | `Account<DataStore>` | ~2× comp | Lz4 decompress + checksum |
| `read_chunked_full` | `Account<DataStore>` | ~2× comp | Full ChunkedLz4 decompress |
| `read_chunked_chunk` | `Account<DataStore>` | ~4 KB | Single-chunk decompress — O(chunk_size) |
| `append_raw_large` | `AccountInfo` | ~800 B | Zero-copy append; no deserialization OOM |
| `compress_stored_chunked_large` | `AccountInfo` | ~3 KB | Zero-copy ChunkedLz4; safe at 90 KB |

## Build & test

```bash
anchor build                  # compile the Anchor program
anchor test                   # run all benchmarks (starts local validator automatically)
cargo test -p densol --test scenarios --features chunked_lz4 -- --nocapture  # pure-Rust scenario tests
```

Package manager: **yarn** (see Anchor.toml).

## Feature flags

The program's `default` features include `lz4`, `discriminant`, and `chunked_lz4`. Instructions gated on `#[cfg(feature = "chunked_lz4")]` are always compiled in the default build. The densol crate's `chunked_lz4` feature enables `ChunkedLz4`.

## Test suite structure (`tests/compress_bench.ts`)

- `WRITE (tx-limited)` — sizes 256/512/800 B, all 4 datasets
- `READ (account-limited)` — sizes 256 B–10 KB, all 4 datasets
- `WRITE (chunked_lz4)` — same write sizes with ChunkedLz4
- `READ (chunked_lz4 full)` — full decompress benchmark
- `READ (chunked_lz4 per-chunk)` — single-chunk read at 1 KB and 4 KB
- `LARGE ACCOUNT DEMO (OpenBook-shaped, 90 KB)` — uses `appendRawLarge` + `compressStoredChunkedLarge`; runs once, not in a loop

`after()` hook prints all tables and writes `results/benchmark.json`.

## Data generators

| Label | Pattern | Why |
|---|---|---|
| `repetitive` | 66-byte ASCII string tiled | High LZ4 ratio baseline |
| `json-like` | 160-byte JSON fragment tiled | Realistic metadata |
| `pseudoRandom` | LCG PRNG | Incompressible worst case |
| `orderbook` | 80-byte entry (price f64 + qty f64 + side byte + 63 zero bytes) | Mirrors OpenBook BookSide |

## Real-world data (mainnet, 2026-03-21)

| Account | Raw | Compressed | Ratio | Rent saved |
|---|---|---|---|---|
| OpenBook SOL/USDC Bids | 90,952 B | 1,693 B | 53.72x | ~0.621 SOL |
| OpenBook SOL/USDC Asks | 90,952 B | 1,672 B | 54.40x | ~0.621 SOL |
| Drift User (inactive) | 4,376 B | 265 B | 16.51x | ~0.029 SOL |
| Drift User (semi-active) | 4,376 B | 811 B | 5.40x | ~0.025 SOL |
| Drift User (active) | 4,376 B | 1,671 B | 2.62x | ~0.019 SOL |

OpenBook BookSide is `bytemuck::Pod` (zero-copy) — storing compressed bytes breaks the layout invariant; densol integration requires program-side adoption. Drift User is Borsh — direct densol integration applies.

## ChunkedLz4 chunk size recommendation

`ChunkedLz4<4096>` is the default: near-maximum compression (80-byte orderbook pattern fills ~51× within a 4 KB window) and each `decompress_chunk` call uses only ~4 KB heap. Smaller chunks (512 B, 1 KB) compress significantly worse.
