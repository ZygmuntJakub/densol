# densol — ROADMAP

Items ordered by impact × feasibility. Nothing here is scheduled; this is a research and
implementation backlog informed by the benchmark findings.

---

## Phase 1 — Algorithm research (heatshrink / lzss)

### Background

The benchmark suite confirms that back-references are essential for real-world data (RLE
achieves 1.0× on cycling-phrase data while LZ4 achieves 83×). The current on-chain compress
limit is ~15 KB for random data and ~30 KB for structured data, constrained by LZ4 needing
`N + output(N)` heap simultaneously.

Two candidates identified during research as SBF-viable but **not yet implemented or tested**:

### 1a. heatshrink

- **What it is:** LZSS-style compressor by Scott Vokes (MIT licence), written for embedded
  systems. C library; Rust ports exist.
- **Why interesting:** Input ring-buffer + search index are both configurable at compile time.
  At `HEATSHRINK_STATIC_INPUT_BUFFER_SIZE=256` + `HEATSHRINK_STATIC_WINDOW_BITS=8`:
  encoder state ≈ 256 + 256 = 512 bytes, entirely stack-allocated.
- **Ratio expectation:** Lower than LZ4 for large inputs (shorter back-reference window), but
  potentially comparable to LZ4 for common NFT metadata patterns at 1–4 KB.
- **SBF compatibility:** Likely — no_std supported, no dynamic allocation in encoder. Needs
  a Rust `no_std` port audit before integrating.
- **Task:** Port or wrap a `no_std` heatshrink implementation, add as `densol::Heatshrink`,
  benchmark against LZ4 on the same 21-combination suite.

### 1b. lzss crate

- **What it is:** `lzss` on crates.io — configurable LZSS with `const` parameters for ring
  buffer size. `no_std` + `alloc`.
- **Ring buffer size:** 4 KB default, configurable down to 256 B. Stack-allocated.
- **SBF compatibility:** Likely — verified `no_std` + `alloc` API. Needs heap audit to confirm
  no hidden `Box` allocs.
- **Task:** Add `lzss` feature flag to `densol`, benchmark against LZ4.

### Success criteria

Benchmark run showing heatshrink or lzss achieving ≥ 40× on repetitive data at 10 KB on-chain,
within the 32 KB SBF heap, with write CU comparable to or better than LZ4.

---

## Phase 2 — Custom GlobalAlloc for accounts > 15 KB

### Background

`ComputeBudgetProgram.requestHeapFrame(65536)` extends the heap frame to 64 KB, but the default
Solana bump allocator hardcodes 32 KB and ignores the extended frame. To use more than 32 KB
of heap, a custom `GlobalAlloc` must be provided.

### Approach

```rust
// In programs/compress_bench/src/lib.rs (or a shared crate)
use std::alloc::{GlobalAlloc, Layout};

struct SolanaHeap;

unsafe impl GlobalAlloc for SolanaHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // Use sol_alloc_free syscall directly with bump pointer into extended frame.
        ...
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static HEAP: SolanaHeap = SolanaHeap;
```

### Risk

- Custom allocators in Anchor programs interact with Anchor's own heap usage (discriminants,
  Borsh deserialisation). Requires careful testing that Anchor's internal allocations still work.
- The bump allocator can never reclaim memory — with a 64 KB frame, the compress limit doubles
  (~30 KB random, ~62 KB structured), but the bump constraint remains.
- **Not needed for the primary use case** (accounts ≤ 15 KB cover the vast majority of NFT
  metadata, config, and serialised state).

### Success criteria

`compress_stored` succeeds on a 20 KB random input account on localnet with
`requestHeapFrame(65536)` and a custom bump allocator.

---

## Phase 3 — Off-chain compress / on-chain decompress (deflate pipeline)

### Background

`densol::Deflate` already implements decompress-only on-chain (miniz_oxide inflate, small state)
and compress off-chain (miniz_oxide deflate, 128 KB heap — impossible on SBF). The test suite
currently does not exercise the end-to-end path of:

1. Client compresses data with zlib/deflate (Node.js `zlib.deflateRaw`)
2. Client uploads compressed bytes via `append_chunk`
3. On-chain `benchmark_decompress` calls `get_data()` → `Deflate::decompress`

### Tasks

- Add TypeScript helper `compressDeflate(data: Buffer): Buffer` using Node.js `zlib.deflateRawSync`.
- Add a test case that exercises the full deflate pipeline for 10 KB repetitive/json-like/random.
- Document in README: deflate pipeline achieves higher ratios off-chain at the cost of an
  extra client-side step; viable for write-once accounts (NFT metadata stored permanently).
- Benchmark: deflate ratio vs LZ4 ratio on the same datasets.

### Expected outcome

Deflate typically achieves 10–30% better ratio than LZ4 on structured text. The trade-off is
that compression happens off-chain (no CU cost) and on-chain decompress is identical to LZ4's.
For write-once accounts this is strictly better than LZ4 from a ratio perspective.

---

## Phase 4 — crates.io publication

### Pre-conditions

- [ ] All `unsafe` code audited and documented.
- [ ] `densol` compiles cleanly for both native (`std`) and SBF (`no_std`) targets with
  `cargo check --target sbf-solana-solana`.
- [ ] `densol-derive` proc-macro tested with edge cases (multiple `#[compress]` fields,
  non-`Vec<u8>` field types rejected gracefully with helpful error).
- [ ] CHANGELOG.md created with 0.1.0 entry.
- [ ] Minimum Rust edition and MSRV documented in `Cargo.toml`.

### Publish order

1. `densol` (core trait + implementations — no proc-macro dependency)
2. `densol-derive` (depends on `densol` for derive codegen)

### API stability

Before 1.0: the `Compressor` trait is stable; discriminant values are stable (encoded in
on-chain data). The `Strategy` alias pattern in the derive macro may change before 1.0.

---

## Phase 5 — Expanded benchmarks

### Additional dataset archetypes

| Dataset | Rationale |
|---------|-----------|
| Anchor account (real program state) | Most realistic; Borsh-serialised structs with u64/pubkey fields |
| Compressed NFT metadata (Metaplex standard) | High-value target: URI strings, attributes arrays |
| Token account batch (N × 165 B) | Tests whether framing overhead matters at 165 B granularity |
| Zero-padded account (sparse allocation) | Best case for RLE; useful for comparing against LZ4 |

### Mainnet verification

Localnet CU counts match mainnet for deterministic computation. Rent calculations use
`getMinimumBalanceForRentExemption` which is identical. No mainnet test run required before
publishing, but a single mainnet spot-check at 10 KB would confirm no regression.

---

## Non-goals (explicitly out of scope)

- **zstd on-chain:** zstd decoder requires ~100–200 KB heap state. Not viable on SBF without
  a reimplementation or a custom compact variant.
- **Streaming decompression:** The `get_data()` / `set_data()` API is intentionally
  bulk-oriented. Streaming would require a fundamentally different account layout.
- **Multi-field compression:** `#[derive(Compress)]` currently targets a single `Vec<u8>`
  field. Compressing multiple fields independently adds discriminant overhead per field; the
  use case is niche enough to leave for post-1.0.
- **Encrypted compression:** Compression before encryption leaks information via ratio (CRIME
  attack analogue). densol should never be combined with field-level encryption.
