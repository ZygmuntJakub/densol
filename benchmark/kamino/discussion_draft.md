# Title
Discovery: On-chain compression for inactive Obligation accounts (~2,400 SOL recoverable rent)

---

# Body

Hey — I ran a full scan of Kamino Lending on mainnet and benchmarked on-chain LZ4 compression for inactive `Obligation` accounts. Sharing in case the team finds it useful.

**Mainnet scan** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/kamino/scan.ts), full scan of all 131,456 accounts):

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **113,922** | 86.7% |
| Active | 17,542 | 13.3% |

**On-chain compression benchmark** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/kamino/benchmark.ts), 50 random inactive accounts):

```
Raw:               3,344 B
Compressed:          291 B avg  (min 190 B, max 506 B)
Compression ratio:  12.4x avg

Compress CU:        40,210  (one-time keeper cost)
Decompress CU:      52,818  (per chunk read, on demand)

Rent saved:         0.0213 SOL/account
Total recoverable: ~2,421 SOL  (~$198K at current price)
```

Two tiers in the data: obligations with no prior positions compress to ~190 B (17×) — collateral and liquidity slots are zeroed. Obligations with prior borrow/deposit history land around 330–500 B (7–10×) due to non-zero accumulated interest and market value snapshots.

**How it works:** [densol](https://crates.io/crates/densol) is a `no_std` LZ4 library that runs inside the Solana SBF VM — no libc, no std allocator, fits within the 32 KB heap. `Obligation` at 3,344 B compresses in a single `ChunkedLZ4` pass at 40,210 CU.

Since `Obligation` is Borsh-encoded, integration is straightforward — compression can be applied in-place with a discriminator flag change, and decompression triggered on the first deposit, borrow, or repay. No struct layout constraints to work around.

**For curiosity, has this been considered ever?**
