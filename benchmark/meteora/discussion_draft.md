# Title
Discovery: On-chain compression for idle BinArray accounts (~19,700 SOL recoverable rent)

---

# Body

Hey — I ran a full scan of Meteora DLMM on mainnet and benchmarked on-chain LZ4 compression for idle `BinArray` accounts. Sharing in case the team finds it useful.

**Mainnet scan** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/meteora/scan.ts), full scan of all 139,185 pools):

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **125,156** | 89.9% |
| Active | 14,029 | 10.1% |

That's **331,732 `BinArray` accounts** (10,136 B each) sitting idle on dead pools.

**On-chain compression benchmark** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/meteora/benchmark.ts), 50 random inactive accounts):

```
Raw:               10,136 B
Compressed:         1,606 B avg  (min 787 B, max 3,620 B)
Compression ratio:   7.6x avg

Compress CU:       136,990  (one-time keeper cost)
Decompress CU:      61,960  (per 4 KB chunk, on demand)

Rent saved:         0.0594 SOL/account
Total recoverable: ~19,695 SOL  (~$1.62M at current price)
```

The ratio is lower than some other AMMs (e.g. Raydium TickArrays compress 55×) because Meteora `BinArray` stores accumulated fee data and bin prices even for dead pools — bins contain non-zero data. Still, 7.6× is solid compression for real-world fee-bearing state.

**How it works:** [densol](https://crates.io/crates/densol) is a `no_std` LZ4 library that runs inside the SBF VM (fits within 32 KB heap, no libc). `BinArray` at 10 KB uses `ChunkedLZ4` — 4 KB chunks processed sequentially, ~4 KB heap peak per chunk.

Since `BinArray` is a zero-copy account, integration would use a hibernation pattern — a discriminator flag marks the account as compressed, the compressed bytes occupy the shrunken account, and on first swap or liquidity event the program decompresses and restores the account. The pool creator or protocol treasury receives the freed rent difference.

Happy to discuss integration details or help prototype. For curiosity, has this been considered ever?
