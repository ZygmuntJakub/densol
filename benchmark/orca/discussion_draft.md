# Title
Discovery: On-chain compression for idle TickArray accounts (~6,750 SOL recoverable rent)

---

# Body

Hey — I ran a full scan of Orca Whirlpools on mainnet and benchmarked on-chain LZ4 compression for idle `TickArray` accounts. Numbers came out very strong, sharing in case the team finds it useful.

**Mainnet scan** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/orca/scan.ts)):

**98,667 `TickArray` accounts** (9,988 B each) on inactive pools.

**On-chain compression benchmark** ([script](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/orca/benchmark.ts), 50 random inactive accounts):

```
Raw:               9,988 B
Compressed:          155 B avg  (min 150 B, max 223 B)
Compression ratio:  64.7x avg

Compress CU:        87,432  (one-time keeper cost)
Decompress CU:      65,513  (per 4 KB chunk, on demand)

Rent saved:         0.0684 SOL/account
Total recoverable: ~6,753 SOL  (~$564K at current price)
```

The ratio is this extreme because inactive tick slots are fully zeroed — a dead pool TickArray is effectively a ~10 KB zero buffer with a small header. LZ4 compresses zero runs to near nothing.

**How it works:** [densol](https://crates.io/crates/densol) is a `no_std` LZ4 library that runs inside the SBF VM (fits within 32 KB heap, no libc). `TickArray` at ~10 KB uses `ChunkedLZ4` — 4 KB chunks processed sequentially, ~4 KB heap peak per chunk.

Since `TickArray` is `zero_copy` (`#[repr(C, packed)]`), integration would use a hibernation pattern — a discriminator flag marks the account as compressed, the compressed bytes occupy the shrunken account, and on first swap crossing an initialized tick the program decompresses and restores the account. The pool creator or protocol treasury receives the freed rent difference.

**For curiosity, has this been considered ever?**
