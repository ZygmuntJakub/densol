# densol: on-chain LZ4 compression for Solana programs

Transparent LZ4 compression for Anchor account fields. Store less data, pay less rent.

> I couldn't find measured data on whether on-chain compression is worth the extra CU, so I measured it. If you spot a mistake, open an issue

## Use densol

```toml
densol = "0.1"
```

```rust
use densol::Lz4 as Strategy;
use densol::Compress;

#[account]
#[derive(Compress)]
pub struct MyAccount {
    #[compress]
    pub data: Vec<u8>,
}

// my_account.set_data(&raw_bytes)?;  // compress + store
// let raw = my_account.get_data()?;  // decompress + return
```

## When to compress

| Situation | Recommendation |
|-----------|----------------|
| Structured data (JSON, repeated patterns, zero-padded structs) | ✓ Compress — rent saving is immediate and permanent |
| Random or already-compressed data | ✗ Don't — LZ4 expands it and costs extra CU with no benefit |
| Short-lived accounts (closed within hours) | ✗ Not worth it — rent refund eliminates the saving |
| Accounts ≤ 10 KB, need full decompression on-chain | Use plain `Lz4` |
| Accounts > 10 KB, or need partial reads | Use `ChunkedLz4::decompress_chunk` |

## Why LZ4 fits the SBF heap

The SBF VM has a 32 KB bump-allocated heap. Most compressors (zstd, gzip) fail here. LZ4 works because lz4_flex places its compression hash table (`[u32; 4096]` = 16 KB) on the *stack*, not the heap. Heap allocations during compression reduce to one output buffer (~N bytes), giving peak heap ≈ 2× input size.

This yields a practical in-program compression ceiling around 10–12 KB. The exact limit is data-dependent: the heap must hold both the compressed and original forms simultaneously, so well-compressed data allows larger inputs than random data at the same raw size. Above the ceiling, compress off-chain and upload pre-compressed bytes.

## A note on CU cost and break-even

The Solana base fee (5,000 lamports/signature) is fixed regardless of CU consumed. Extra CU only costs lamports via the *priority fee*, which is optional. At zero priority fee — the default for most transactions — compression adds no extra lamport cost whatsoever. The rent saving is pure profit.

The break-even column below assumes a conservative priority fee of 1,000 µL/CU. At that rate the extra cost per read is 1–57 lamports; the one-time rent saving is hundreds of thousands of lamports. The numbers in the millions of reads are not a warning — they confirm that CU overhead is effectively never a binding constraint for compressible data.

## Run benchmarks

```bash
# Pure-Rust: sizes and rent savings (no Solana CLI needed)
cargo test -p densol --test scenarios --features chunked_lz4 -- --nocapture

# CU measurements (requires Anchor + local validator)
anchor test
```

## Results

### Lz4 — write (tx-limited sizes)

Sizes are limited to 800 B by the transaction payload cap. Compression ratios grow with size because LZ4 builds up more back-reference context.

| Data type | Size | Compressed | Ratio | Store raw CU | Store compressed CU | Overhead CU | Rent saving (lamports) | Break-even writes¹ |
|-----------|-----:|-----------:|------:|-------------:|--------------------:|------------:|-----------------------:|-------------------:|
| repetitive | 256 B | 84 B | 3.05x | 4,840 | 9,800 | 4,960 | +1,197,120 | 241,355 |
| repetitive | 512 B | 85 B | 6.02x | 4,840 | 10,277 | 5,437 | +2,971,920 | 546,610 |
| repetitive | 800 B | 86 B | 9.30x | 4,840 | 10,852 | 6,012 | +4,969,440 | 826,587 |
| json-like | 256 B | 147 B | 1.74x | 4,840 | 13,473 | 8,633 | +758,640 | 87,877 |
| json-like | 512 B | 148 B | 3.46x | 4,840 | 14,018 | 9,178 | +2,533,440 | 276,034 |
| json-like | 800 B | 149 B | 5.37x | 4,840 | 14,593 | 9,753 | +4,530,960 | 464,571 |
| random | 256 B | 263 B | 0.97x | 4,840 | 11,990 | 7,150 | -48,720 | harmful |
| random | 512 B | 520 B | 0.98x | 4,840 | 14,630 | 9,790 | -55,680 | harmful |
| random | 800 B | 810 B | 0.99x | 4,840 | 16,825 | 11,985 | -69,600 | harmful |
| orderbook | 256 B | 38 B | 6.74x | 4,840 | 8,663 | 3,823 | +1,517,280 | 396,882 |
| orderbook | 512 B | 39 B | 13.13x | 4,840 | 9,204 | 4,364 | +3,292,080 | 754,372 |
| orderbook | 800 B | 40 B | 20.00x | 4,840 | 11,025 | 6,185 | +5,289,600 | 855,230 |

The orderbook type (8 B price + 8 B quantity + 1 B side + 63 B zero padding per entry) compresses better than even repetitive text because the dense zero runs are trivial for LZ4 to encode.

### Lz4 — read (account-limited sizes)

Accounts are set up via chunked `store_raw` calls followed by an in-place `compress_stored`. OOM rows indicate that `compress_stored` exceeded the 32 KB heap — the raw data plus its compressed form would not both fit simultaneously. Well-compressed data (reptitive, orderbook) reaches 10 KB cleanly; random data cannot compress past ~4 KB because the "compressed" output is nearly the same size as the input.

| Data type | Size | Compressed | Ratio | Read raw CU | Read compressed CU | Overhead CU | Rent saving (lamports) | Break-even reads¹ |
|-----------|-----:|-----------:|------:|------------:|-------------------:|------------:|-----------------------:|------------------:|
| repetitive | 256 B | 84 B | 3.05x | 4,021 | 5,483 | 1,462 | +1,197,120 | 818,824 |
| repetitive | 512 B | 85 B | 6.02x | 6,581 | 9,462 | 2,881 | +2,971,920 | 1,031,558 |
| repetitive | 1 KB | 87 B | 11.77x | 11,705 | 17,424 | 5,719 | +6,521,520 | 1,140,325 |
| repetitive | 2 KB | 91 B | 22.51x | 21,949 | 33,344 | 11,395 | +13,620,720 | 1,195,324 |
| repetitive | 4 KB | 99 B | 41.37x | 42,441 | 65,176 | 22,735 | +27,819,120 | 1,223,625 |
| repetitive | 8 KB | 115 B | 71.23x | 83,433 | 128,851 | 45,418 | +56,215,920 | 1,237,745 |
| repetitive | 10 KB | 123 B | 83.25x | 103,940 | 160,694 | 56,754 | +70,414,320 | 1,240,694 |
| json-like | 256 B | 147 B | 1.74x | 4,021 | 5,455 | 1,434 | +758,640 | 529,038 |
| json-like | 512 B | 148 B | 3.46x | 6,581 | 9,433 | 2,852 | +2,533,440 | 888,303 |
| json-like | 1 KB | 150 B | 6.83x | 11,705 | 17,395 | 5,690 | +6,083,040 | 1,069,076 |
| json-like | 2 KB | 154 B | 13.30x | 21,949 | 33,315 | 11,366 | +13,182,240 | 1,159,796 |
| json-like | 4 KB | 162 B | 25.28x | 42,441 | 65,147 | 22,706 | +27,380,640 | 1,205,877 |
| json-like | 8 KB | 178 B | 46.02x | 83,433 | 128,811 | 45,378 | +55,777,440 | 1,229,174 |
| json-like | 10 KB | 186 B | 55.05x | 103,940 | 160,654 | 56,714 | +69,975,840 | 1,233,837 |
| random | 256 B | 263 B | 0.97x | 4,021 | 4,496 | 475 | -48,720 | harmful |
| random | 512 B | 520 B | 0.98x | 6,581 | 7,179 | 598 | -55,680 | harmful |
| random | 1 KB | 1,034 B | 0.99x | 11,709 | 12,557 | 848 | -69,600 | harmful |
| random | 2 KB | 2,062 B | 0.99x | 21,949 | 23,289 | 1,340 | -97,440 | harmful |
| random | 4 KB | 4,119 B | 0.99x | 42,441 | 44,776 | 2,335 | -160,080 | harmful |
| random | 8 KB | — | 1.00x | 83,444 | OOM² | — | 0 | OOM |
| random | 10 KB | — | 1.00x | 103,951 | OOM² | — | 0 | OOM |
| orderbook | 256 B | 38 B | 6.74x | 4,010 | 5,794 | 1,784 | +1,517,280 | 850,493 |
| orderbook | 512 B | 39 B | 13.13x | 6,570 | 9,773 | 3,203 | +3,292,080 | 1,027,811 |
| orderbook | 1 KB | 41 B | 24.98x | 11,705 | 17,746 | 6,041 | +6,841,680 | 1,132,541 |
| orderbook | 2 KB | 45 B | 45.51x | 21,945 | 33,662 | 11,717 | +13,940,880 | 1,189,799 |
| orderbook | 4 KB | 53 B | 77.28x | 42,437 | 65,494 | 23,057 | +28,139,280 | 1,220,422 |
| orderbook | 8 KB | 69 B | 118.72x | 83,433 | 129,162 | 45,729 | +56,536,080 | 1,236,329 |
| orderbook | 10 KB | 77 B | 132.99x | 103,940 | 161,005 | 57,065 | +70,734,480 | 1,239,542 |

¹ Break-even = `rent_saving / (overhead_CU × 0.000001 L)` at 1,000 µL/CU priority fee. At zero priority fee the break-even is infinite — compression is always net positive.

² OOM on `compress_stored`: compressed and raw forms of ~8 KB of random data both fit on the 32 KB heap simultaneously, but Anchor account deserialization leaves insufficient headroom. Well-compressed data (repetitive, orderbook) doesn't hit this because the compressed form is tiny.

### ChunkedLz4 — large accounts

Plain `Lz4` OOMs on decompression above roughly 10 KB because it allocates the entire output at once. `ChunkedLz4<N>` splits input into independent N-byte chunks and exposes `decompress_chunk(data, i)` — an O(chunk_size) heap call. On-chain code reads only the chunks it needs; the total account size is irrelevant to heap pressure.

The wire format is N-agnostic: data compressed with `ChunkedLz4<512>` can be decompressed by `ChunkedLz4<4096>` and vice versa.

**Rent savings at large account sizes (`ChunkedLz4<4096>`):**

| Data type | Size | Compressed | Ratio | Chunks | Rent saving |
|-----------|-----:|-----------:|------:|-------:|------------:|
| repetitive | 32 KB | 849 B | 38.60x | 8 | +222,156,240 L |
| json-like | 32 KB | 1,358 B | 24.13x | 8 | +218,613,600 L |
| pseudo-random | 32 KB | 33,017 B | 0.99x | 8 | -1,733,040 L |
| orderbook | 32 KB | 490 B | 66.87x | 8 | +224,654,880 L |
| repetitive | 64 KB | 1,689 B | 38.80x | 16 | +444,375,120 L |
| json-like | 64 KB | 2,702 B | 24.25x | 16 | +437,324,640 L |
| pseudo-random | 64 KB | 66,025 B | 0.99x | 16 | -3,403,440 L |
| orderbook | 64 KB | 977 B | 67.08x | 16 | +449,330,640 L |
| repetitive | 90 KB | 2,416 B | 38.15x | 23 | +624,618,240 L |
| json-like | 90 KB | 3,874 B | 23.79x | 23 | +614,470,560 L |
| pseudo-random | 90 KB | 92,850 B | 0.99x | 23 | -4,802,400 L |
| orderbook | 90 KB | 1,391 B | 66.25x | 23 | +631,752,240 L |
| repetitive | 256 KB | 6,729 B | 38.96x | 64 | +1,777,688,400 L (~1.8 SOL) |
| json-like | 256 KB | 10,806 B | 24.26x | 64 | +1,749,312,480 L (~1.7 SOL) |
| pseudo-random | 256 KB | 264,073 B | 0.99x | 64 | -13,425,840 L |
| orderbook | 256 KB | 3,886 B | 67.46x | 64 | +1,797,475,680 L (~1.8 SOL) |
| repetitive | 512 KB | 13,449 B | 38.98x | 128 | +3,555,439,440 L (~3.6 SOL) |
| json-like | 512 KB | 21,613 B | 24.26x | 128 | +3,498,618,000 L (~3.5 SOL) |
| pseudo-random | 512 KB | 528,137 B | 0.99x | 128 | -26,789,040 L |
| orderbook | 512 KB | 7,762 B | 67.55x | 128 | +3,595,020,960 L (~3.6 SOL) |
| repetitive | 1 MB | 26,889 B | 39.00x | 256 | +7,110,941,520 L (~7.1 SOL) |
| json-like | 1 MB | 43,212 B | 24.27x | 256 | +6,997,333,440 L (~7.0 SOL) |
| pseudo-random | 1 MB | 1,056,265 B | 0.99x | 256 | -53,515,440 L |
| orderbook | 1 MB | 15,521 B | 67.56x | 256 | +7,190,062,800 L (~7.2 SOL) |
| repetitive | 4 MB | 107,529 B | 39.01x | 1,024 | +28,443,954,000 L (~28.4 SOL) |
| json-like | 4 MB | 172,829 B | 24.27x | 1,024 | +27,989,466,000 L (~28.0 SOL) |
| pseudo-random | 4 MB | 4,225,032 B | 0.99x | 1,024 | -213,866,880 L |
| orderbook | 4 MB | 62,062 B | 67.58x | 1,024 | +28,760,404,320 L (~28.8 SOL) |

The 90 KB orderbook row mirrors a realistic OpenBook `BookSide` account (90 KB of raw state → 1,391 B compressed, 66.25× ratio, ~0.63 SOL saved). The on-chain compression benchmark (`largeAccountDemo`) confirms this: 90,952 B → 1,386 B, compressCu=764,131 (~55% of the 1.4 M budget). Compression ratios plateau as chunk count grows because LZ4 already reaches maximum context within the first few chunks.

**Chunk size vs compression ratio** — because LZ4 only back-references within the current chunk, smaller chunks mean less context. Fixed input: 90 KB orderbook:

| Chunk size | Compressed | Ratio | Chunks |
|-----------:|-----------:|------:|-------:|
| 512 B | 8,397 B | 10.98x | 180 |
| 1,024 B | 4,383 B | 21.03x | 90 |
| 4,096 B | 1,391 B | 66.25x | 23 |

`ChunkedLz4<4096>` is the recommended default: near-maximum compression (the 80-byte pattern fills ~51× within a 4 KB chunk) while each `decompress_chunk` call uses only ~4 KB of heap.

### ChunkedLz4 — per-chunk read CU

> **What this benchmark measures:** The test accounts are 1–4 KB, which fit in exactly one 4 KB chunk (`ceil(1024/4096) = ceil(4096/4096) = 1`). The table shows the cost of decompressing *one chunk*. For multi-chunk accounts, this cost is paid once per chunk you access, independent of total account size. A 90 KB account has 23 chunks; reading one of them costs the same CU as shown here for 4 KB.

| Data type | Input | Compressed | Chunks | Read raw CU | Chunk CU | Overhead CU |
|-----------|------:|-----------:|-------:|------------:|---------:|------------:|
| repetitive | 1 KB | 102 B | 1 | 11,705 | 17,526 | 5,821 |
| repetitive | 4 KB | 114 B | 1 | 42,441 | 65,278 | 22,837 |
| json-like | 1 KB | 164 B | 1 | 11,705 | 17,491 | 5,786 |
| json-like | 4 KB | 176 B | 1 | 42,441 | 65,243 | 22,802 |
| random | 1 KB | 1,050 B | 1 | 11,709 | 12,638 | 929 |
| random | 4 KB | 4,135 B | 1 | 42,441 | 44,857 | 2,416 |
| orderbook | 1 KB | 56 B | 1 | 11,705 | 17,847 | 6,142 |
| orderbook | 4 KB | 68 B | 1 | 42,437 | 65,595 | 23,158 |

For structured data the per-chunk overhead is ~5,800–6,100 CU per 1 KB and ~22,800–23,200 CU per 4 KB chunk. The 1,400,000 CU budget can cover ~60 chunks of 1 KB or ~60 chunks of 4 KB in a single transaction — enough to scan a full 90 KB orderbook (23 × 4 KB chunks) with room to spare.

### Real-world accounts (mainnet)

Measured on live mainnet accounts fetched 2026-03-21 via `getAccountInfo`.

| Account | Size | Compressed | Ratio | Rent saved |
|---------|-----:|-----------:|------:|-----------:|
| OpenBook v2 SOL/USDC Bids (BookSide) | 90,952 B | 1,693 B | **53.72x** | ~0.621 SOL |
| OpenBook v2 SOL/USDC Asks (BookSide) | 90,952 B | 1,672 B | **54.40x** | ~0.621 SOL |
| Drift User (inactive, mostly empty) | 4,376 B | 265 B | **16.51x** | ~0.029 SOL |
| Drift User (semi-active) | 4,376 B | 811 B | **5.40x** | ~0.025 SOL |
| Drift User (active) | 4,376 B | 1,671 B | **2.62x** | ~0.019 SOL |

**Drift User accounts** (4.4 KB, Borsh) are a direct `densol` integration target — well within the 32 KB heap limit. Even the worst case (active user) compresses 2.6× and saves rent permanently.

**OpenBook BookSide accounts** (90 KB, zero-copy `bytemuck::Pod`) show the rent-saving potential: ~54× compression, ~0.62 SOL per account. Plain `Lz4` cannot process 90 KB on-chain (heap limit). `ChunkedLz4<4096>` with `AccountInfo`-based bypass deserialization keeps peak heap at ~3 KB, making large-account on-chain compression feasible. BookSide stores data as a `bytemuck::Pod` struct with an exact binary layout — storing compressed bytes in the same account would break the layout invariant, so densol integration requires off-chain compression or program-side adoption.

### ChunkedLz4 — write and full-read CU

> **Note:** For accounts ≤ 10 KB, prefer plain `Lz4` — it gives better compression and lower write CU than `ChunkedLz4` at small sizes. The overhead difference ranges from ~990 CU (repetitive 256 B) to ~4,250 CU (repetitive 800 B). The tables below are included for completeness and for cases where `ChunkedLz4` format is required at all sizes.
>
> **Why ChunkedLz4 write CU is higher:** The custom on-chain compressor allocates the LZ4 hash table (8 KB) once per `compress()` call and reuses it across all chunks, clearing between chunks. This replaces the old approach of delegating to `lz4_flex` per chunk, which stranded one hash table per chunk on the SBF bump allocator — 23 chunks × 8 KB = 188 KB for a 90 KB account. The new approach keeps peak heap at ~3 KB regardless of account size, enabling MB-scale on-chain compression. Write CU increased ~10–40%; the rent-saving break-even is unchanged.

**Write (256–800 B):**

| Data type | Size | Compressed | Ratio | Store raw CU | Store chunk CU | Overhead CU | Rent saving (lamports) |
|-----------|-----:|-----------:|------:|-------------:|---------------:|------------:|-----------------------:|
| repetitive | 256 B | 99 B | 2.59x | 4,840 | 10,789 | 5,949 | +1,092,720 |
| repetitive | 512 B | 100 B | 5.12x | 4,840 | 12,829 | 7,989 | +2,867,520 |
| repetitive | 800 B | 101 B | 7.92x | 4,840 | 15,148 | 10,308 | +4,865,040 |
| json-like | 256 B | 161 B | 1.59x | 4,840 | 12,879 | 8,039 | +661,200 |
| json-like | 512 B | 162 B | 3.16x | 4,840 | 14,942 | 10,102 | +2,436,000 |
| json-like | 800 B | 163 B | 4.91x | 4,840 | 17,293 | 12,453 | +4,433,520 |
| random | 256 B | 279 B | 0.92x | 4,840 | 14,525 | 9,685 | -160,080 |
| random | 512 B | 536 B | 0.96x | 4,840 | 22,476 | 17,636 | -167,040 |
| random | 800 B | 826 B | 0.97x | 4,840 | 31,433 | 26,593 | -180,960 |
| orderbook | 256 B | 53 B | 4.83x | 4,840 | 9,953 | 5,113 | +1,412,880 |
| orderbook | 512 B | 54 B | 9.48x | 4,840 | 12,016 | 7,176 | +3,187,680 |
| orderbook | 800 B | 55 B | 14.55x | 4,840 | 14,398 | 9,558 | +5,185,200 |

**Full read (256 B – 10 KB; random data OOMs at 10 KB, all other types succeed through 10 KB):**

| Data type | Size | Compressed | Ratio | Read raw CU | Read full CU | Overhead CU |
|-----------|-----:|-----------:|------:|------------:|-------------:|------------:|
| repetitive | 256 B | 99 B | 2.59x | 4,021 | 5,641 | 1,620 |
| repetitive | 512 B | 100 B | 5.12x | 6,581 | 9,631 | 3,050 |
| repetitive | 1 KB | 102 B | 10.04x | 11,705 | 17,593 | 5,888 |
| repetitive | 2 KB | 106 B | 19.32x | 21,949 | 33,513 | 11,564 |
| repetitive | 4 KB | 114 B | 35.93x | 42,441 | 65,351 | 22,910 |
| repetitive | 8 KB | 219 B | 37.41x | 83,433 | 128,944 | 45,511 |
| repetitive | 10 KB | 316 B | 32.41x | 103,940 | 160,710 | 56,770 |
| json-like | 256 B | 161 B | 1.59x | 4,021 | 5,618 | 1,597 |
| json-like | 512 B | 162 B | 3.16x | 6,581 | 9,596 | 3,015 |
| json-like | 1 KB | 164 B | 6.24x | 11,705 | 17,558 | 5,853 |
| json-like | 2 KB | 168 B | 12.19x | 21,949 | 33,478 | 11,529 |
| json-like | 4 KB | 176 B | 23.27x | 42,441 | 65,316 | 22,875 |
| json-like | 8 KB | 349 B | 23.47x | 83,433 | 128,870 | 45,437 |
| json-like | 10 KB | 508 B | 20.16x | 103,940 | 160,609 | 56,669 |
| random | 256 B | 279 B | 0.92x | 4,021 | 4,648 | 627 |
| random | 512 B | 536 B | 0.96x | 6,581 | 7,331 | 750 |
| random | 1 KB | 1,050 B | 0.98x | 11,709 | 12,709 | 1,000 |
| random | 2 KB | 2,078 B | 0.99x | 21,949 | 23,441 | 1,492 |
| random | 4 KB | 4,135 B | 0.99x | 42,441 | 44,934 | 2,493 |
| random | 8 KB | 8,261 B | 0.99x | 83,444 | 88,139 | 4,695 |
| random | 10 KB | — | 1.00x | 103,951 | OOM³ | — |
| orderbook | 256 B | 53 B | 4.83x | 4,010 | 5,951 | 1,941 |
| orderbook | 512 B | 54 B | 9.48x | 6,570 | 9,930 | 3,360 |
| orderbook | 1 KB | 56 B | 18.29x | 11,705 | 17,903 | 6,198 |
| orderbook | 2 KB | 60 B | 34.13x | 21,945 | 33,819 | 11,874 |
| orderbook | 4 KB | 68 B | 60.24x | 42,437 | 65,657 | 23,220 |
| orderbook | 8 KB | 124 B | 66.06x | 83,433 | 129,597 | 46,164 |
| orderbook | 10 KB | 179 B | 57.21x | 103,940 | 161,710 | 57,770 |

³ OOM on `read_chunked_full` for random 10 KB: the full decompressed output (~10 KB) plus the working buffers exceed the 32 KB heap. Use `decompress_chunk` to read individual chunks without this limit.

## Missing pieces

- Mainnet priority fee sensitivity analysis (current benchmark assumes 1,000 µL/CU)
- Alternative algorithms: heatshrink and lzss use ~256–512 B heap vs LZ4's 16 KB stack (see [ROADMAP.md](ROADMAP.md))

## License

Licensed under [Apache License 2.0](LICENSE-APACHE).
