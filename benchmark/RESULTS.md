# On-chain compression benchmarks — mainnet results

Benchmarks run with **[densol](https://crates.io/crates/densol)** — a `no_std` LZ4 library
running inside the Solana SBF VM. All compression and decompression happens on-chain,
with no client-side pre-processing.

Scanned: March 2026. SOL prices at time of benchmark.

---

## Summary

| Protocol | Account | Raw size | Compressed | Ratio | CU compress | CU decomp | Rent saved | Inactive accounts | Total recoverable | Issue |
|---|---|---|---|---|---|---|---|---|---|---|
| Drift | `User` | 4,376 B | 226 B | **21.9×** | 22,330 | 69,856 | 0.0289 SOL | 193,866 / 207,987 (93.2%) | **~5,605 SOL** | [#2162](https://github.com/orgs/drift-labs/discussions/2162) |
| OpenBook v2 | `BookSide` | 90,952 B | 1,683 B | **54.1×** | ~300,000 | ~65,000 | 0.621 SOL | 228 markets / 271 (84.1%) | **~283 SOL** | — |
| Raydium CLMM | `TickArrayState` | 10,240 B | 190 B | **55.1×** | 90,940 | 64,604 | 0.0699 SOL | 324,670 TAs (153,496 / 168,744 pools inactive) | **~22,709 SOL** | [#173](https://github.com/raydium-io/raydium-clmm/issues/173) |
| Meteora DLMM | `BinArray` | 10,136 B | 1,606 B | **7.6×** | 136,990 | 61,960 | 0.0594 SOL | 331,732 BAs (125,156 / 139,185 pools inactive) | **~19,695 SOL** | [#277](https://github.com/MeteoraAg/dlmm-sdk/issues/277) |
| Orca Whirlpools | `TickArray` | 9,988 B | 155 B | **64.7×** | 87,432 | 65,513 | 0.0684 SOL | 98,667 TAs (inactive pools) | **~6,753 SOL** | [#1279](https://github.com/orca-so/whirlpools/issues/1279) |
| Marginfi | `MarginfiAccount` | 2,312 B | 141 B | **17.6×** | 26,714 | 37,407 | 0.0151 SOL | 506,233 / 512,497 (98.8%) | **~7,650 SOL** | [#544](https://github.com/0dotxyz/marginfi-v2/issues/544) |
| Kamino Lend | `Obligation` | 3,344 B | 291 B | **12.4×** | 40,210 | 52,818 | 0.0213 SOL | 113,922 / 131,456 (86.7%) | **~2,421 SOL** | — |

**Total across all protocols: ~65,116 SOL (~$5.3M)**

---

## Drift Protocol — `User` account

**Scan** ([script](drift/scan.ts)): full scan of all 207,987 `User` accounts on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **193,866** | 93.2% |
| Active | 11,727 | 5.6% |
| Errors skipped | 2,394 | 1.1% |

**Benchmark** ([script](drift/benchmark.ts)): 100 random inactive accounts.

```
Raw:               4,376 B
Compressed:          226 B avg  (min 189 B, max 811 B)
Compression ratio:  21.9x avg

Compress CU:        22,330  (one-time keeper cost)
Decompress CU:      69,856  (on demand)

Rent saved:         0.0289 SOL/account
Total recoverable: ~5,605 SOL
```

**Why it compresses well:** Drift `User` is Borsh-encoded with large zero-padded arrays
(positions, orders, spot balances) that are empty for inactive accounts.

**Integration:** Straightforward — `User` is Borsh-encoded, no struct layout constraints.
A `compress_user` instruction compresses in-place; decompression on first access.

---

## OpenBook v2 — `BookSide` account

**Scan** ([script](openbook/scan.ts)): full scan of all 271 OpenBook v2 markets on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive markets (no tx > 30 d) | **228** | 84.1% |
| Active | 43 | 15.9% |

Each inactive market has 2 idle `BookSide` accounts (bids + asks) of 90,952 B each.

**Benchmark** ([script](openbook/benchmark.ts)): 5 sampled inactive markets (bids + asks).

```
Raw:               90,952 B
Compressed:         1,683 B avg
Compression ratio:  54.1x avg

Rent saved:         0.621 SOL/BookSide  (×2 per market = 1.242 SOL)
Total recoverable: ~283 SOL  (BookSides only; EventHeap TBD)
```

**Why it compresses well:** `BookSide` is a sparse order book — most tick nodes are empty
(zero-filled), and LZ4 compresses zero runs extremely efficiently.

**Integration:** `BookSide` is `bytemuck::Pod` (zero-copy). Requires hibernation pattern:
discriminator flag marks the account as compressed, decompression restores the account
on first order placement or cancellation.

---

## Raydium CLMM — `TickArrayState` account

**Scan** ([script](raydium/scan.ts)): full scan of all 168,744 Raydium CLMM pools on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive pools (no tx > 30 d) | **153,496** | 91.0% |
| Active | 15,248 | 9.0% |

383,489 total `TickArrayState` accounts; **324,670** on inactive pools.

**Benchmark** ([script](raydium/benchmark.ts)): 50 random inactive TickArrays.

```
Raw:               10,240 B  (fixed size)
Compressed:           190 B avg  (min 165 B, max 385 B)
Compression ratio:   55.1x avg

Compress CU:         90,940  (one-time keeper cost)
Decompress CU:       64,604  (per 4 KB chunk, on demand)

Rent saved:          0.0699 SOL/account
Total recoverable:  ~22,709 SOL  (~$1.98M at $87.27/SOL)
```

**Why it compresses so well:** Inactive tick slots are all zeros. LZ4 compresses runs of
zeros to near nothing — the ~10 KB account shrinks to ~190 B.

**Integration:** `TickArrayState` is zero-copy (`bytemuck::Pod`). Requires hibernation
pattern. A keeper compresses idle TickArrays; on first swap crossing an initialized tick
the program decompresses via a separate instruction before the swap executes.

---

## Meteora DLMM — `BinArray` account

**Scan** ([script](meteora/scan.ts)): full scan of all 139,185 Meteora DLMM pools on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive pools (no tx > 30 d) | **125,156** | 89.9% |
| Active | 14,029 | 10.1% |

400,941 total `BinArray` accounts; **331,732** on inactive pools.
`lb_pair` pubkey detected at offset 24 in `BinArray`.

**Benchmark** ([script](meteora/benchmark.ts)): 50 random inactive BinArrays.

```
Raw:               10,136 B  (fixed size)
Compressed:         1,606 B avg  (min 787 B, max 3,620 B)
Compression ratio:   7.6x avg

Compress CU:       136,990  (one-time keeper cost)
Decompress CU:      61,960  (per 4 KB chunk, on demand)

Rent saved:         0.0594 SOL/account
Total recoverable: ~19,695 SOL  (~$1.62M at $82.25/SOL)
```

**Why ratio is lower than Raydium:** Meteora `BinArray` stores accumulated fee data and
bin prices even for inactive pools — bins contain non-zero data. Raydium `TickArrayState`
for truly dead pools is nearly all zeros.

**Integration:** `BinArray` is zero-copy. Same hibernation pattern as Raydium.
A keeper compresses idle BinArrays; decompression before first swap on pool reactivation.

---

## Orca Whirlpools — `TickArray` account

**Scan** ([script](orca/scan.ts)): full scan of all Orca Whirlpool pools on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive pools (no tx > 30 d) | (scan in progress) | — |
| Active | — | — |

**98,667** `TickArray` accounts on inactive pools.
`whirlpool` pubkey detected at offset 9,956 (end of struct: `size - 32`).

**Benchmark** ([script](orca/benchmark.ts)): 50 random inactive TickArrays.

```
Raw:               9,988 B  (fixed size)
Compressed:          155 B avg  (min 150 B, max 223 B)
Compression ratio:  64.7x avg

Compress CU:        87,432  (one-time keeper cost)
Decompress CU:      65,513  (per 4 KB chunk, on demand)

Rent saved:         0.0684 SOL/account
Total recoverable: ~6,753 SOL  (~$564K at $83.59/SOL)
```

**Why it compresses extremely well:** Orca `TickArray` is `zero_copy` (`#[repr(C, packed)]`).
Inactive tick slots (113 B each, 88 per array) are fully zeroed. Dead pool TickArrays are
effectively pure zero runs — LZ4 compresses them to ~150 B regardless of account size.

**Integration:** `TickArray` is zero-copy. Requires hibernation pattern — identical to Raydium.
A keeper compresses idle TickArrays; on first swap crossing an initialized tick the program
decompresses via a separate instruction before the swap executes.

---

## Marginfi (Project Zero) — `MarginfiAccount`

**Scan** ([script](marginfi/scan.ts)): full scan of all 512,497 `MarginfiAccount` accounts on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **506,233** | 98.8% |
| Active | 6,264 | 1.2% |
| Never used | 0 | 0% |

**Benchmark** ([script](marginfi/benchmark.ts)): 50 random inactive accounts.

```
Raw:               2,312 B  (fixed size)
Compressed:          141 B avg  (min 112 B, max 307 B)
Compression ratio:  17.6x avg

Compress CU:        26,714  (one-time keeper cost — lowest of all protocols)
Decompress CU:      37,407  (per chunk read, on demand)

Rent saved:         0.0151 SOL/account
Total recoverable: ~7,650 SOL  (~$631K at $82.53/SOL)
```

**Two compression tiers observed:**
- **113 B (20.5×):** accounts with zero active positions — pure zero-padded `LendingAccount.balances` array (16 × 104 B = 1,664 B of zeros)
- **~232 B (10×):** accounts with 1–2 prior positions — non-zero balance/fee accumulator data

**Why 98.8% inactive:** Marginfi's 2023–2024 points farming campaign drove millions of wallets to open accounts with minimal deposits to qualify, then never return.

**Integration:** `MarginfiAccount` is `zero_copy` (`bytemuck::Pod`). Requires hibernation pattern — same as Raydium/Orca. Compress CU (26,714) is the lowest measured, making keeper operation cheap.

---

## Kamino Lending — `Obligation` account

**Scan** ([script](kamino/scan.ts)): full scan of all 131,456 `Obligation` accounts on mainnet.

| Status | Count | % |
|---|---|---|
| Inactive (no tx > 30 d) | **113,922** | 86.7% |
| Active | 17,542 | 13.3% |

**Benchmark** ([script](kamino/benchmark.ts)): 50 random inactive accounts.

```
Raw:               3,344 B  (fixed size)
Compressed:          291 B avg  (min 190 B, max 506 B)
Compression ratio:  12.4x avg

Compress CU:        40,210  (one-time keeper cost)
Decompress CU:      52,818  (per chunk read, on demand)

Rent saved:         0.0213 SOL/account
Total recoverable: ~2,421 SOL  (~$198K at $81.77/SOL)
```

**Two compression tiers observed:**
- **~190–240 B (14–17×):** obligations with no deposit/borrow history — collateral and liquidity slots are zeroed
- **~330–500 B (7–10×):** obligations with prior positions — non-zero accumulated interest, market value snapshots, and borrow factor data

**Integration:** `Obligation` is Borsh-encoded (`#[account]`). Compression can be applied in-place with a discriminator flag change; decompression on first deposit, borrow, or repay.

---

## Notes

- CU figures are measured on localnet from real mainnet account data.
- Rent savings = `getMinimumBalanceForRentExemption(raw) - getMinimumBalanceForRentExemption(compressed)`.
- "Total recoverable" uses `compress_stored_chunked` (ChunkedLZ4, 4 KB chunks) for accounts ≤ 12 KB,
  and `compress_stored_chunked_large` (zero-copy AccountInfo) for larger accounts.
- Production instructions must explicitly transfer freed lamports to the account owner.
- All scripts: [github.com/ZygmuntJakub/densol](https://github.com/ZygmuntJakub/densol)
