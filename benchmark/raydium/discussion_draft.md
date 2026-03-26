# Title
Discovery: On-chain compression for idle TickArrayState accounts (~22,700 SOL recoverable rent)

---

# Body

Hey — I ran a full scan of Raydium CLMM on mainnet and benchmarked on-chain LZ4 compression for idle `TickArrayState` accounts. Numbers came out surprisingly strong, sharing in case the team finds it useful.

**Mainnet scan** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/raydium/scan.ts), full scan of all 168,744 pools):

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **153,496** | 91.0% |
| Active | 15,248 | 9.0% |

That's **324,670 `TickArrayState` accounts** (10,240 B each) sitting idle on dead pools.

**On-chain compression benchmark** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/raydium/benchmark.ts), 50 random inactive accounts):

```
Raw:               10,240 B
Compressed:           190 B avg  (min 165 B, max 385 B)
Compression ratio:  55.12x avg

Compress CU:        90,940  (one-time keeper cost)
Decompress CU:      64,604  (per 4 KB chunk, on demand)

Rent saved:         0.0699 SOL/account
Total recoverable: ~22,709 SOL  (~$1.98M at current price)
```

The ratio is this extreme because idle tick slots are almost entirely zeros — LZ4 compresses zero runs to near nothing.

**How it works:** [densol](https://crates.io/crates/densol) is a `no_std` LZ4 library that runs inside the SBF VM (fits within 32 KB heap, no libc). `TickArrayState` at 10 KB uses `ChunkedLZ4` — 4 KB chunks processed sequentially, ~4 KB heap peak per chunk.

Since `TickArrayState` is a zero-copy account, integration would use a hibernation pattern — a discriminator flag marks the account as compressed, the compressed bytes occupy the shrunken account, and on first access (swap crossing an initialized tick) the program decompresses and restores the account. The pool creator / protocol treasury receives the freed rent difference.

Happy to discuss integration details or help prototype. For curiosity, has this been considered ever?
