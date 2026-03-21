# densol: on-chain LZ4 compression for Solana programs

Transparent LZ4 compression for Anchor account fields. Store less data, pay less rent.

> I couldn't find measured data on whether on-chain compression is worth the extra CU, so I measured it. If you spot a mistake, open an issue.

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
| repetitive | 32 KB | 857 B | 38.24x | 8 | +222,100,560 L |
| json-like | 32 KB | 1,375 B | 23.83x | 8 | +218,495,280 L |
| pseudo-random | 32 KB | 33,017 B | 0.99x | 8 | -1,733,040 L |
| orderbook | 32 KB | 498 B | 65.80x | 8 | +224,599,200 L |
| repetitive | 64 KB | 1,705 B | 38.44x | 16 | +444,263,760 L |
| json-like | 64 KB | 2,738 B | 23.94x | 16 | +437,074,080 L |
| pseudo-random | 64 KB | 66,025 B | 0.99x | 16 | -3,403,440 L |
| orderbook | 64 KB | 993 B | 66.00x | 16 | +449,219,280 L |
| repetitive | 90 KB | 2,439 B | 37.79x | 23 | +624,458,160 L |
| json-like | 90 KB | 3,921 B | 23.50x | 23 | +614,143,440 L |
| pseudo-random | 90 KB | 92,850 B | 0.99x | 23 | -4,802,400 L |
| orderbook | 90 KB | 1,414 B | 65.18x | 23 | +631,592,160 L |
| repetitive | 256 KB | 6,793 B | 38.59x | 64 | +1,777,242,960 L (~1.8 SOL) |
| json-like | 256 KB | 10,940 B | 23.96x | 64 | +1,748,379,840 L (~1.7 SOL) |
| pseudo-random | 256 KB | 264,073 B | 0.99x | 64 | -13,425,840 L |
| orderbook | 256 KB | 3,950 B | 66.37x | 64 | +1,797,030,240 L (~1.8 SOL) |
| repetitive | 512 KB | 13,577 B | 38.62x | 128 | +3,554,548,560 L (~3.6 SOL) |
| json-like | 512 KB | 21,874 B | 23.97x | 128 | +3,496,801,440 L (~3.5 SOL) |
| pseudo-random | 512 KB | 528,137 B | 0.99x | 128 | -26,789,040 L |
| orderbook | 512 KB | 7,890 B | 66.45x | 128 | +3,594,130,080 L (~3.6 SOL) |
| repetitive | 1 MB | 27,145 B | 38.63x | 256 | +7,109,159,760 L (~7.1 SOL) |
| json-like | 1 MB | 43,745 B | 23.97x | 256 | +6,993,623,760 L (~7.0 SOL) |
| pseudo-random | 1 MB | 1,056,265 B | 0.99x | 256 | -53,515,440 L |
| orderbook | 1 MB | 15,777 B | 66.46x | 256 | +7,188,281,040 L (~7.2 SOL) |
| repetitive | 4 MB | 108,553 B | 38.64x | 1,024 | +28,436,826,960 L (~28.4 SOL) |
| json-like | 4 MB | 174,979 B | 23.97x | 1,024 | +27,974,502,000 L (~28.0 SOL) |
| pseudo-random | 4 MB | 4,225,033 B | 0.99x | 1,024 | -213,873,840 L |
| orderbook | 4 MB | 63,086 B | 66.49x | 1,024 | +28,753,277,280 L (~28.8 SOL) |

The 90 KB orderbook row mirrors a realistic OpenBook `BookSide` account (90 KB of raw state → 1.4 KB compressed, 65× ratio, ~0.63 SOL saved). Compression ratios plateau as chunk count grows because LZ4 already reaches maximum context within the first few chunks.

**Chunk size vs compression ratio** — because LZ4 only back-references within the current chunk, smaller chunks mean less context. Fixed input: 90 KB orderbook:

| Chunk size | Compressed | Ratio | Chunks |
|-----------:|-----------:|------:|-------:|
| 512 B | 8,577 B | 10.75x | 180 |
| 1,024 B | 4,473 B | 20.60x | 90 |
| 4,096 B | 1,414 B | 65.18x | 23 |

`ChunkedLz4<4096>` is the recommended default: near-maximum compression (the 80-byte pattern fills ~51× within a 4 KB chunk) while each `decompress_chunk` call uses only ~4 KB of heap.

### ChunkedLz4 — per-chunk read CU

> **What this benchmark measures:** The test accounts are 1–4 KB, which fit in exactly one 4 KB chunk (`ceil(1024/4096) = ceil(4096/4096) = 1`). The table shows the cost of decompressing *one chunk*. For multi-chunk accounts, this cost is paid once per chunk you access, independent of total account size. A 90 KB account has 23 chunks; reading one of them costs the same CU as shown here for 4 KB.

| Data type | Input | Compressed | Chunks | Read raw CU | Chunk CU | Overhead CU |
|-----------|------:|-----------:|-------:|------------:|---------:|------------:|
| repetitive | 1 KB | 103 B | 1 | 11,705 | 17,520 | 5,815 |
| repetitive | 4 KB | 115 B | 1 | 42,441 | 65,272 | 22,831 |
| json-like | 1 KB | 166 B | 1 | 11,705 | 17,480 | 5,775 |
| json-like | 4 KB | 178 B | 1 | 42,441 | 65,232 | 22,791 |
| random | 1 KB | 1,050 B | 1 | 11,709 | 12,638 | 929 |
| random | 4 KB | 4,135 B | 1 | 42,441 | 44,857 | 2,416 |
| orderbook | 1 KB | 57 B | 1 | 11,705 | 17,842 | 6,137 |
| orderbook | 4 KB | 69 B | 1 | 42,437 | 65,590 | 23,153 |

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

> **Note:** For accounts ≤ 10 KB, prefer plain `Lz4` — it gives better compression and lower CU than `ChunkedLz4` at small sizes (the per-chunk header adds ~16 B and ~9 CU per write). The tables below are included for completeness and for cases where `ChunkedLz4` format is required at all sizes.

**Write (256–800 B):**

| Data type | Size | Compressed | Ratio | Store raw CU | Store chunk CU | Overhead CU | Rent saving (lamports) |
|-----------|-----:|-----------:|------:|-------------:|---------------:|------------:|-----------------------:|
| repetitive | 256 B | 100 B | 2.56x | 4,840 | 9,809 | 4,969 | +1,085,760 |
| repetitive | 512 B | 101 B | 5.07x | 4,840 | 10,355 | 5,515 | +2,860,560 |
| repetitive | 800 B | 102 B | 7.84x | 4,840 | 10,898 | 6,058 | +4,858,080 |
| json-like | 256 B | 163 B | 1.57x | 4,840 | 13,505 | 8,665 | +647,280 |
| json-like | 512 B | 164 B | 3.12x | 4,840 | 14,017 | 9,177 | +2,422,080 |
| json-like | 800 B | 165 B | 4.85x | 4,840 | 14,626 | 9,786 | +4,419,600 |
| random | 256 B | 279 B | 0.92x | 4,840 | 12,057 | 7,217 | -160,080 |
| random | 512 B | 536 B | 0.96x | 4,840 | 14,698 | 9,858 | -167,040 |
| random | 800 B | 826 B | 0.97x | 4,840 | 16,857 | 12,017 | -180,960 |
| orderbook | 256 B | 54 B | 4.74x | 4,840 | 8,662 | 3,822 | +1,405,920 |
| orderbook | 512 B | 55 B | 9.31x | 4,840 | 9,208 | 4,368 | +3,180,720 |
| orderbook | 800 B | 56 B | 14.29x | 4,840 | 9,812 | 4,972 | +5,178,240 |

**Full read (256 B – 4 KB; OOMs above ~4 KB for same reason as Lz4 in-program compression):**

| Data type | Size | Compressed | Ratio | Read raw CU | Read full CU | Overhead CU |
|-----------|-----:|-----------:|------:|------------:|-------------:|------------:|
| repetitive | 256 B | 100 B | 2.56x | 4,021 | 5,783 | 1,762 |
| repetitive | 512 B | 101 B | 5.07x | 6,581 | 9,762 | 3,181 |
| repetitive | 1 KB | 103 B | 9.94x | 11,705 | 17,724 | 6,019 |
| repetitive | 2 KB | 107 B | 19.14x | 21,949 | 33,644 | 11,695 |
| repetitive | 4 KB | 115 B | 35.62x | 42,441 | 65,482 | 23,041 |
| json-like | 256 B | 163 B | 1.57x | 4,021 | 5,744 | 1,723 |
| json-like | 512 B | 164 B | 3.12x | 6,581 | 9,722 | 3,141 |
| json-like | 1 KB | 166 B | 6.17x | 11,705 | 17,684 | 5,979 |
| json-like | 2 KB | 170 B | 12.05x | 21,949 | 33,604 | 11,655 |
| json-like | 4 KB | 178 B | 23.01x | 42,441 | 65,442 | 23,001 |
| random | 256 B | 279 B | 0.92x | 4,021 | 4,785 | 764 |
| random | 512 B | 536 B | 0.96x | 6,581 | 7,468 | 887 |
| random | 1 KB | 1,050 B | 0.98x | 11,709 | 12,846 | 1,137 |
| random | 2 KB | 2,078 B | 0.99x | 21,949 | 23,578 | 1,629 |
| random | 4 KB | 4,135 B | 0.99x | 42,441 | 45,071 | 2,630 |
| orderbook | 256 B | 54 B | 4.74x | 4,010 | 6,083 | 2,073 |
| orderbook | 512 B | 55 B | 9.31x | 6,570 | 10,062 | 3,492 |
| orderbook | 1 KB | 57 B | 17.96x | 11,705 | 18,035 | 6,330 |
| orderbook | 2 KB | 61 B | 33.57x | 21,945 | 33,951 | 12,006 |
| orderbook | 4 KB | 69 B | 59.36x | 42,437 | 65,789 | 23,352 |

## Missing pieces

- Mainnet priority fee sensitivity analysis (current benchmark assumes 1,000 µL/CU)
- Alternative algorithms: heatshrink and lzss use ~256–512 B heap vs LZ4's 16 KB stack (see [ROADMAP.md](ROADMAP.md))

## License

Licensed under [Apache License 2.0](LICENSE-APACHE).
