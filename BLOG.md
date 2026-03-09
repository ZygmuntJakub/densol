# On-Chain Compression on Solana: The Counter-Intuitive Results

*A benchmark-driven investigation into whether LZ4 compression inside an SBF program
is viable, useful, and perhaps cheaper than not compressing at all.*

---

Every Solana developer eventually hits the same wall: account data is expensive.
Rent-exempt storage costs about 6.96 lamports per byte per year at current rates, and that cost
is paid upfront as a minimum balance the account must maintain. For a program that stores
1 KB of NFT metadata per account across 100 000 accounts, that is roughly 700 SOL locked up
permanently — just in rent.

The obvious question: can you compress that data?

The less obvious question: what actually happens to your compute units?

---

## The Setup

I built a benchmark program — `densol` — that runs two storage strategies side by side on a
Solana localnet and measures real transaction CU counts with `getTransaction().meta.computeUnitsConsumed`.
No simulation (Anchor's `.simulate()` is unreliable for large accounts with `realloc`). Real
executed transactions.

**Case A (raw):** Upload raw bytes via `append_chunk`, read back with a byte checksum.

**Case B (compressed):** Upload raw bytes, call `compress_stored` (which compresses in-place
on-chain), read back with `benchmark_decompress` (which decompresses then checksums).

Three dataset archetypes, seven sizes each (256 B to 10 240 B): cycling NFT metadata phrases
(repetitive), realistic JSON metadata (json-like), and LCG pseudo-random bytes (incompressible).
Twenty-one combinations. All measured on the same instruction set.

The compression algorithm: `lz4_flex 0.11`, the most popular LZ4 implementation for Rust.

---

## The Surprising Result

Here is what I expected:

> Compression costs extra CU to write but saves rent. At some break-even read count, the
> rent savings pay back the compression overhead.

Here is what actually happened at 10 240 bytes:

| Data type | Raw O(N) read CU | Compress+write CU | Ratio |
|-----------|------------------:|------------------:|------:|
| Repetitive NFT phrases | 103 940 | **28 319** | **3.7× cheaper to compress** |
| JSON-like metadata | 103 940 | **32 015** | **3.2× cheaper to compress** |

The `compress_stored` instruction — which compresses 10 KB in-place on-chain — uses **fewer
compute units than a simple O(N) byte-sum over the same raw data.** The "Raw O(N) read CU"
column is the cost of `benchmark_raw`: Borsh deserialisation + iterating every byte. It
represents the minimal cost of any instruction that touches all N bytes of account data.

This is backwards from every intuition I had going in.

---

## Why It Happens

The raw read instruction (`benchmark_raw`) does this:

```
Borsh deser → iterate 10 240 bytes → sum every byte (O(N))
```

At ~10 CU per byte, that is ~103 000 CU just for the byte-sum.

The compress instruction (`compress_stored`) does this:

```
Borsh deser → LZ4 compress 10 240 bytes → realloc account to 123 bytes
```

LZ4 compression costs about **2.5 CU per input byte** — not 10. And once the data is compressed
to 123 bytes, everything downstream (account realloc, serialisation) operates on the smaller
buffer. The fixed overhead of LZ4 hash-table initialisation (~4 000–8 500 CU per call)
amortises quickly over any input larger than a few hundred bytes.

The crossover happens at ~1 KB: for all structured data above that threshold, the compress
instruction is cheaper than a raw O(N) pass. The mechanism is not "compression is fast" —
it is that **LZ4 processes bytes at 2.5 CU/B while a naive iteration costs ~10 CU/B on SBF.**

Important caveat: the comparison is between `compress_stored` (a write) and `benchmark_raw`
(a read with O(N) work). The raw *write* path (`append_chunk`) does no per-byte work and is
cheaper than either. The insight is: if your program does any O(N) processing on account
data, that processing alone costs more CU than LZ4 compression of the same bytes.

---

## The Read Side

The read path tells the opposite story:

| Original size | Extra CU to read (vs raw) |
|--------------|--------------------------|
| 256 B | +975 CU |
| 1 024 B | +5 831 CU |
| 4 096 B | +22 827 CU |
| 10 240 B | +56 944 CU |

Every read of a compressed account costs more than reading the same data raw. LZ4 decompress
costs ~5.5 CU per output byte; add the checksum on the decompressed data and you are paying
~15.5 CU per byte versus ~10 CU for raw. That is a 50% per-read overhead that never goes away.

The break-even analysis (at what read count do rent savings cover cumulative read overhead?)
converges to approximately **1.2 million reads** for large accounts at 1 000 µlamports/CU.
That number is, for most programs, effectively unreachable.

The practical economic driver is not read amortisation. It is the rent you reclaim when the
account closes — that money comes back in one transaction regardless of how many times the
account was read.

---

## The 32 KB Wall

The SBF runtime heap is 32 KB. The Solana bump allocator never frees memory within a single
program invocation — every allocation accumulates until the instruction ends.

During `compress_stored`, the memory layout is:

```
raw bytes (N)       ← moved from account with std::mem::take, no new alloc
LZ4 hash table      ← [u32; 4096], STACK-ALLOCATED (this was a surprise)
output buffer       ← heap alloc, ≈ N + N/100 + 27 bytes
```

The critical discovery: lz4_flex's hash table lives on the stack, not the heap. This is what
makes on-chain LZ4 compression fit within 32 KB. Without `std::mem::take`, the raw bytes would
be duplicated on the heap (raw + clone + output ≈ 3N), blowing the heap for anything above ~5 KB.
With `take`, peak heap is `N + output(N)` — roughly 2N for random data, less for compressible data.

The practical limits:

| Data type | On-chain compress limit |
|-----------|------------------------|
| Random (incompressible) | ~15 KB |
| JSON-like metadata | ~25 KB |
| Repetitive phrases | ~31 KB |

One thing that does **not** help: `ComputeBudgetProgram.requestHeapFrame(65536)`. The default
Solana bump allocator ignores the extended frame and always caps at 32 KB. Using more heap
requires a custom `GlobalAlloc`, which is complex and risky in an Anchor program. It is on the
roadmap but not in v0.1.

---

## The RLE Experiment: Proving That Back-References Matter

After establishing LZ4's numbers, I wanted to answer a harder question: is LZ4 special, or
would any compression algorithm work?

I implemented a PackBits-style RLE encoder as a baseline. The logic is simple: scan for runs
of ≥3 identical consecutive bytes and encode them as 2-byte packets; pack everything else as
literal packets. O(1) heap state — only the output buffer needs to be allocated. It runs
comfortably within 32 KB at any account size.

The results on the same 21-combination benchmark suite:

| Data type | LZ4 ratio (10 KB) | RLE ratio (10 KB) | LZ4 write CU | RLE write CU |
|-----------|------------------:|------------------:|-------------:|-------------:|
| Repetitive NFT phrases | **83×** | **1.0×** | 28 319 | 401 378 |
| JSON-like metadata | **55×** | **1.3×** | 32 015 | 328 620 |
| Random (incompressible) | **OOM** | **1.0×** | OOM | 399 546 |

Random data at 10 KB causes an out-of-memory crash with LZ4 on-chain — the SBF heap (32 KB)
cannot hold both the raw input (~10 KB) and the incompressible output (~10 KB) simultaneously.
At smaller sizes (≤ 4 KB), LZ4 on random data produces ratio ≈ 1.0× — strictly harmful.

Every single RLE case is harmful. Not just "not as good as LZ4" — harmful. Writing compressed
data costs 3–15× more compute and saves zero rent because the account does not shrink.

The reason: the "repetitive" dataset cycles a 66-character ASCII phrase. Every character in
the phrase is distinct. When the 66th character wraps back to the 1st, there are never three
consecutive identical bytes anywhere in the stream. RLE finds nothing to compress. The account
stays at 10 240 bytes, and the O(N) checksum still costs 103 000 CU — now with extra overhead
on top.

LZ4 achieves 83× on the same input because it uses **back-references**: after seeing the
66-byte phrase once, every subsequent occurrence is encoded as a 3-byte pointer into recent
history. The phrase repeats hundreds of times per kilobyte. That is what back-references are for.

The json-like RLE ratio of 1.3× comes entirely from one field: `So11111111111111111111111111111111111111112` — a Solana base58 address with 42 consecutive `1` characters. That single run is the only byte-level repetition in the entire dataset. Even there, RLE's write CU is 11× worse than LZ4.

The conclusion: for the data patterns that actually appear in on-chain programs — JSON metadata,
NFT attributes, Protobuf-like serialised structs, config records — byte-level RLE is categorically
unsuitable. Any useful compression algorithm for this domain needs back-references.

---

## So Is LZ4 the Only Option?

The short answer is: probably not, but it is the only one that has been properly tested here.

Research turned up two other candidates that might work within SBF constraints:

**heatshrink** — an LZSS compressor designed for embedded systems. The encoder ring buffer and
search index are compile-time constants; at `WINDOW_BITS=8` the entire encoder state fits in
~512 bytes on the stack. It is `no_std`-capable and has Rust ports. The expected ratio is lower
than LZ4 for large inputs (shorter history window), but for 1–4 KB NFT metadata at phrase-level
repetition it might be competitive. Not yet benchmarked.

**lzss crate** — a Rust `no_std + alloc` LZSS implementation with configurable ring buffer size
(as small as 256 bytes). Stack-allocated. Not yet benchmarked.

The working assumption for v0.1 is: LZ4 is the best-tested, most practical option for SBF
on-chain compression. The heatshrink and lzss investigation is on the roadmap.

---

## What This Means Practically

For programs that store structured data ≥ 1 KB:

- The `compress_stored` instruction costs **fewer CU** than any instruction that does O(N)
  work on the same raw bytes, for N ≥ 1 KB. This is because LZ4 processes bytes at ~2.5 CU/B
  while a naive iteration costs ~10 CU/B on SBF.

- Rent savings are realised in full when the account closes. At 10 KB of NFT metadata, that is
  ~69 000 µlamports (≈0.07 lamports) per account — small per account, meaningful at scale.

- Every read pays a decompression overhead of ~5.5 CU per output byte. For programs that read
  the same account thousands of times, evaluate this cost explicitly.

- Compression is harmful when the data is incompressible (random/encrypted) and small: LZ4
  framing inflates the account slightly and rent increases. For incompressible data at any
  size, there are no rent savings — the account does not shrink.

The crate is available at [github.com/jakubzygmunt/compress_bench](https://github.com/jakubzygmunt/compress_bench).
The derive macro usage is one attribute:

```rust
#[account]
#[derive(Compress)]
pub struct DataStore {
    #[compress]
    pub data: Vec<u8>,
}
```

`set_data(&raw_bytes)` compresses and stores. `get_data()` loads and decompresses. Everything
else is the same Anchor program you already know how to write.

---

*All benchmark numbers are from real executed transactions on Solana localnet (not simulation).
The full dataset, methodology notes, and raw tables are in FINDINGS.md in the repository.*
