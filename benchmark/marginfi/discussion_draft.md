# Title
Discovery: On-chain compression for inactive MarginfiAccounts (~7,650 SOL recoverable rent)

---

# Body

Hey — I ran a full scan of Marginfi on mainnet and benchmarked on-chain LZ4 compression for inactive `MarginfiAccount` accounts. Numbers came out surprisingly strong, sharing in case the team finds it useful.

**Mainnet scan** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/marginfi/scan.ts), full scan of all 512,497 accounts):

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **506,233** | 98.8% |
| Active | 6,264 | 1.2% |

**On-chain compression benchmark** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/marginfi/benchmark.ts), 50 random inactive accounts):

```
Raw:               2,312 B
Compressed:          141 B avg  (min 112 B, max 307 B)
Compression ratio:  17.6x avg

Compress CU:        26,714  (one-time keeper cost)
Decompress CU:      37,407  (per chunk read, on demand)

Rent saved:         0.0151 SOL/account
Total recoverable: ~7,650 SOL  (~$631K at current price)
```

Two tiers visible in the data: accounts with no active positions compress to ~113 B (20.5×) — the `LendingAccount.balances` array (16 × 104 B = 1,664 B) is pure zeros. Accounts with prior positions land around 232 B (10×) due to non-zero balance state.

**How it works:** [densol](https://crates.io/crates/densol) is a `no_std` LZ4 library that runs inside the Solana SBF VM — no libc, no std allocator, fits within the 32 KB heap. At 2,312 B, `MarginfiAccount` compresses in a single `ChunkedLZ4` pass at just 26,714 CU — the lowest keeper cost across all six protocols I benchmarked.

Since `MarginfiAccount` is `zero_copy` (`bytemuck::Pod`), integration would use a hibernation pattern — a flag in `account_flags` marks the account as compressed, the compressed bytes occupy the shrunken account, and on first deposit/borrow/withdraw the program decompresses and restores the account. The account authority receives the freed rent difference.

**For curiosity, has this been considered ever?**
