# Title
Idea: on-chain LZ4 compression for inactive User accounts (~5,650 SOL recoverable rent)

---

# Body

Hey folks — I was curious how much rent could be recovered on Drift using
on-chain compression, so I scanned all **207,987 `User` accounts** on mainnet
(filtered by discriminator + `dataSize: 4376`). "Inactive" = no transaction
in the last 30 days.

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **193,866** | 93.2% |
| Active | 11,727 | 5.6% |
| Errors skipped | 2,394 | 1.1% |

That's a lot of 4,376 B accounts sitting idle.
[Scan script here.](https://github.com/ZygmuntJakub/densol/blob/main/benchmark/drift/scan.ts)

I then ran an on-chain benchmark using **[densol](https://crates.io/crates/densol)** —
a `no_std` LZ4 library that compresses inside the SBF VM. I fetched a real
inactive `User` account from mainnet and ran compression on localnet:

```
Raw: 4,376 B → Compressed: 189 B (23×)
Rent saved:            0.029 SOL per account

Compress   (one-time keeper cost):  22,330 CU
Decompress (per read, on demand):   69,856 CU
```

Total recoverable across all inactive accounts: **~5,650 SOL**.

One idea: compression could be reversed automatically when an account
sees traffic again — decompress on first access, recompress if it goes
quiet. `User` is Borsh-encoded (not `bytemuck::Pod`), so there are no
struct layout constraints.

Has this ever been considered? Happy to dig into integration details.
