# densol: on-chain LZ4 compression for Solana programs

Transparent LZ4 compression for Anchor account fields. Store less data, pay less rent.

I'm a software engineer who is new to Solana. I had a question which is hard to find an answer: is on-chain compression actually worth the extra CU? So I measured it. This repo is the result. If you spot a mistake, open an issue.

## Use densol

```toml
# Cargo.toml
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

// Generated methods:
// my_account.set_data(&raw_bytes)?;   // compress + store
// let raw = my_account.get_data()?;   // load + decompress
```

## Run tests

Requires [Rust](https://rustup.rs), [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools), and [Anchor](https://www.anchor-lang.com/docs/installation).

```bash
anchor test
```

## The Problem

As a beginner when I visualize Solana I see various components with properties and connections between them. Components are Accounts. Accounts store data and hold tokens. Programs (special executable accounts) execute instructions that read and modify other accounts. When we store more data on a single account we need to pay more rent. The rent is deposited upfront and refunded when we close the account. More data = more rent. Simple, right?

If there would be a way to shrink the data to pay less rent... compress it!

But there is a catch. Compression is not for free, we need more compute to compress and decompress the data. What is a Solana take on that? Every solana instruction consumes compute units (CU). So when we involve compression we need to pay more CU.

Does it mean that compression is not worth it? What is a Solana take on that? I was curious and couldn't find any information about that. So I decided to explore it deeper.

## SBF Runtime

SBF (Solana Binary Format) is the compilation target for Solana programs. It is executed by the Solana runtime (RBPF). The main limit I had to fight against was the heap size: 32 KB bump allocator.

## LZ4 (lz4_flex crate)

It was chosen because it fits within the 32 KB SBF heap. I couldn't use zstd or gzip due to the heap size constraint. lz4_flex (the Rust LZ4 implementation) has one property that makes it uniquely suited to SBF: its hash table is stack-allocated. The hash table is [u32; 4096] = 16 KB, placed on the SBF stack frame, not the heap. This means the only heap allocations during compression are:

```
raw bytes (N)       ← moved from account via std::mem::take (no new alloc)
output buffer       ← one heap alloc, ≈ N + N/100 + 27 bytes
```

## Testing

Now we have a hammer, we need to find a nail. I decided to use a benchmark program testing these scenarios:

- Save raw data to account
- Save compressed data to account
- Load data from account
- Load compressed data from account

Data types:
- Repetitive data (synthetic, best case, highly compressible)
- JSON-like data (synthetic, realistic structured data, moderately compressible)
- Pseudo-random data (synthetic, worst case, incompressible)

and count the compute units consumed.

## Results

### Write benchmark (tx-limited sizes)

Compression always costs more CU than storing raw. This table shows how much more.

- **Ratio**: original size / compressed size (higher = better compression)
- **Store raw CU**: CU to receive data and write it to the account as-is
- **Store compressed CU**: CU to receive data, compress with LZ4, and write
- **Overhead CU**: `store_compressed_CU - store_raw_CU`; extra CU per write caused by compression
- **Rent saving**: `rent_exempt(raw_size) - rent_exempt(compressed_size)` in lamports; pure rent difference, does not include CU cost (negative = compression expanded the data)
- **Break-even writes**: `(rent_saving × 1e6) / (overhead_CU × priority_fee)`; how many writes until the cumulative extra CU cost equals the one-time rent saving. Uses a conservative priority fee of 1,000 µL/CU, at higher mainnet fees the break-even is proportionally lower. (`harmful` = compression expanded the data)

| Data type | Size | Compressed | Ratio | Store raw CU | Store compressed CU | Overhead CU | Rent saving (lamports) | Break-even writes |
|-----------|-----:|-----------:|------:|-------------:|--------------------:|------------:|-----------------:|------------------:|
| repetitive | 256 B | 84 B | 3.05x | 4,840 | 9,800 | 4,960 | +1,197,120 | 241,355 |
| repetitive | 512 B | 85 B | 6.02x | 4,840 | 10,277 | 5,437 | +2,971,920 | 546,610 |
| repetitive | 800 B | 86 B | 9.30x | 4,840 | 10,852 | 6,012 | +4,969,440 | 826,587 |
| json-like | 256 B | 147 B | 1.74x | 4,840 | 13,473 | 8,633 | +758,640 | 87,877 |
| json-like | 512 B | 148 B | 3.46x | 4,840 | 14,018 | 9,178 | +2,533,440 | 276,034 |
| json-like | 800 B | 149 B | 5.37x | 4,840 | 14,593 | 9,753 | +4,530,960 | 464,571 |
| random | 256 B | 263 B | 0.97x | 4,840 | 11,990 | 7,150 | -48,720 | harmful |
| random | 512 B | 520 B | 0.98x | 4,840 | 14,630 | 9,790 | -55,680 | harmful |
| random | 800 B | 810 B | 0.99x | 4,840 | 16,825 | 11,985 | -69,600 | harmful |

### Read benchmark (account-limited sizes)

Decompression always costs more CU than reading raw. The question is whether rent savings justify it.

- **Read raw CU**: CU to read account and compute a checksum over raw bytes
- **Read compressed CU**: CU to read, decompress with LZ4, then checksum
- **Overhead CU**: extra CU per read caused by decompression
- **Break-even reads**: `(rent_saving × 1e6) / (overhead_CU × priority_fee)`; how many reads until the cumulative extra CU cost equals the one-time rent saving. Uses a conservative priority fee of 1,000 µL/CU, at higher mainnet fees the break-even is proportionally lower. (`harmful` = compression expanded the data, no benefit)

| Data type | Size | Compressed | Ratio | Read raw CU | Read compressed CU | Overhead CU | Rent saving (lamports) | Break-even reads |
|-----------|-----:|-----------:|------:|------------:|-------------------:|------------:|-----------------:|-----------------:|
| repetitive | 256 B | 84 B | 3.05x | 4,021 | 5,471 | 1,450 | +1,197,120 | 825,600 |
| repetitive | 512 B | 85 B | 6.02x | 6,581 | 9,450 | 2,869 | +2,971,920 | 1,035,873 |
| repetitive | 1 KB | 87 B | 11.77x | 11,705 | 17,412 | 5,707 | +6,521,520 | 1,142,723 |
| repetitive | 2 KB | 91 B | 22.51x | 21,949 | 33,332 | 11,383 | +13,620,720 | 1,196,584 |
| repetitive | 4 KB | 99 B | 41.37x | 42,441 | 65,164 | 22,723 | +27,819,120 | 1,224,271 |
| repetitive | 8 KB | 115 B | 71.23x | 83,433 | 128,839 | 45,406 | +56,215,920 | 1,238,073 |
| repetitive | 10 KB | 123 B | 83.25x | 103,940 | 160,682 | 56,742 | +70,414,320 | 1,240,956 |
| json-like | 256 B | 147 B | 1.74x | 4,021 | 5,455 | 1,434 | +758,640 | 529,038 |
| json-like | 512 B | 148 B | 3.46x | 6,581 | 9,433 | 2,852 | +2,533,440 | 888,303 |
| json-like | 1 KB | 150 B | 6.83x | 11,705 | 17,395 | 5,690 | +6,083,040 | 1,069,076 |
| json-like | 2 KB | 154 B | 13.30x | 21,949 | 33,315 | 11,366 | +13,182,240 | 1,159,796 |
| json-like | 4 KB | 162 B | 25.28x | 42,441 | 65,147 | 22,706 | +27,380,640 | 1,205,877 |
| json-like | 8 KB | 178 B | 46.02x | 83,433 | 128,811 | 45,378 | +55,777,440 | 1,229,174 |
| json-like | 10 KB | 186 B | 55.05x | 103,940 | 160,654 | 56,714 | +69,975,840 | 1,233,837 |
| random | 256 B | 263 B | 0.97x | 4,021 | 4,480 | 459 | -48,720 | harmful |
| random | 512 B | 520 B | 0.98x | 6,581 | 7,163 | 582 | -55,680 | harmful |
| random | 1 KB | 1,034 B | 0.99x | 11,709 | 12,541 | 832 | -69,600 | harmful |
| random | 2 KB | 2,062 B | 0.99x | 21,949 | 23,273 | 1,324 | -97,440 | harmful |
| random | 4 KB | 4,119 B | 0.99x | 42,441 | 44,760 | 2,319 | -160,080 | harmful |
| random | 8 KB | N/A | 1.00x | 83,444 | OOM | OOM | 0 | OOM |
| random | 10 KB | N/A | 1.00x | 103,951 | OOM | OOM | 0 | OOM |

### Conclusion

For structured data, the rent saving is immediate and permanent. You pay less rent from the moment the account is created. The extra CU cost per operation is small enough that it would take hundreds of thousands of operations to spend back what you saved on rent. In practice, compression is a clear win for structured data. The only case where it backfires is random or already-compressed data, where LZ4 slightly expands the output and costs more CU with nothing to show for it.

> **Before you get too excited:** rent is refunded in full when you close the account. If the account is short-lived, the rent saving evaporates the moment you close it and there is nothing left to offset the extra CU you paid on every operation. Compression makes the most sense for accounts that stick around.

## Missing pieces

- Real-world data types (token metadata, game state, oracle feeds) instead of synthetic payloads
- Mainnet priority fee sensitivity analysis (current benchmark assumes 1,000 µL/CU)
- Alternative algorithms: heatshrink and lzss use ~256-512 B heap vs LZ4's 16 KB stack (see [ROADMAP.md](ROADMAP.md))

## License

Licensed under [Apache License 2.0](LICENSE-APACHE).
