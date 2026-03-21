# Real-World Compression Results — Solana Mainnet

Tested with `compress_tool` (LZ4 block compression) on live mainnet account data.
Fetched via `getAccountInfo` from `api.mainnet-beta.solana.com` on 2026-03-21.

Rent savings formula: `(original - compressed) * 3480 * 2` lamports (rent-exempt minimum per byte).

| account | pubkey | original | compressed | ratio | rent_saved |
|---|---|---|---|---|---|
| OpenBook v2 SOL/USDC Bids (BookSide) | `Ad5skEiFoaeA27G3UhbpuwnFBCvmuuGEyoiijZhcd5xX` | 90952 B | 1693 B | **53.72x** | 621,242,640 lp (~0.621 SOL) |
| OpenBook v2 SOL/USDC Asks (BookSide) | `53v47CBoaKwoM8tSEDN4oNyCc2ZJenDeuhMJTEw7fL2M` | 90952 B | 1672 B | **54.40x** | 621,388,800 lp (~0.621 SOL) |
| Drift User (inactive, mostly empty) | `3e5QUcAj1qWHRjtphaKVguitkZx6Rnun6CSCJibnwxZM` | 4376 B | 265 B | **16.51x** | 28,612,560 lp (~0.029 SOL) |
| Drift User (semi-active) | `DFSJv8AokMzeS7fhL7AJ3WwRGmC9q8mTpUan3zeVYmyP` | 4376 B | 811 B | **5.40x** | 24,812,400 lp (~0.025 SOL) |
| Drift User (active) | `BrRpSaQ6hFDw8darPCyP9Sw7sjydMFQqB4ECAotXSEci` | 4376 B | 1671 B | **2.62x** | 18,826,800 lp (~0.019 SOL) |

## Context

### OpenBook v2 BookSide accounts

- Market account: `CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3` (SOL/USDC)
- OpenBook v2 program: `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`
- BookSide stores a critbit tree of order nodes (80 bytes/node); most tree slots are empty
- ~54x compression — far exceeds the 6–15x estimate
- Note: BookSide is zero-copy (`bytemuck::Pod`) — account bytes must match the struct layout
  exactly, so storing data compressed breaks the invariant. The densol `Compressor` trait
  is format-agnostic (`&[u8]` → `Vec<u8>`); the limitation is architectural, not an API gap.
  These numbers are the pitch case for why on-chain compression matters.

### Drift User accounts

- Drift program: `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- User struct: 4376 bytes (Borsh, 8 perp positions + 8 spot positions + 32 orders)
- Compression scales with inactivity: inactive users (empty position arrays) compress 16x;
  active users with real orders/positions compress 2–5x
- Drift User IS a Borsh account — densol integration directly applicable

## How to Find Accounts (without getProgramAccounts)

Public mainnet RPC blocks `getProgramAccounts`. Two approaches that work:

### OpenBook v2 BookSide — decode market struct

1. Start from a known market address (e.g. `CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3` SOL/USDC, visible in Drift config as an OpenBook fulfillment venue)
2. Fetch the market account raw bytes via `getAccountInfo`
3. Scan every 1-byte-offset window for valid 32-byte pubkeys (~200 candidates from an 848-byte account)
4. Batch-check all candidates via `getMultipleAccounts` with `dataSlice length=0` — no data transferred, just owner + lamports
5. Filter by owner = OpenBook program; matching lamports (~633M) confirm ~90 KB size before fetching

The bids/asks pubkeys are stored as plain `Pubkey` fields inside the Market struct — not PDA-derived — so you can only find them by reading the market account.

### Drift User accounts — follow transactions

1. `getSignaturesForAddress` on the Drift program ID → recent transaction signatures
2. `getTransaction` on each sig → list of account keys involved
3. `getMultipleAccounts` on those keys with `dataSlice length=0` → filter by owner = Drift program
4. Fetch + compress whichever are the right size (~4 KB for User accounts)

No wallet addresses needed. Transactions carry the user accounts as writable accounts, so any recent Drift transaction reveals real user pubkeys.

### General pattern

```
getSignaturesForAddress(program) → getTransaction → accountKeys → getMultipleAccounts(dataSlice=0) → filter by owner/lamports → getAccountInfo (full data)
```

`dataSlice length=0` is key: it returns owner + lamports without transferring account data, so you can cheaply scan many candidates before fetching only what you need.

## Break-even Analysis

Break-even formula from README: `(rent_saving × 1e6) / (overhead_CU × priority_fee)`.
Priority fee: 1,000 µL/CU (conservative mainnet estimate).
CU overhead interpolated from the read benchmark in README (json-like 4 KB row: **22,706 CU overhead**,
closest measured size to Drift User's 4376 B).

| account | rent_saved (lp) | overhead CU/read | break-even reads | at 100 tx/day |
|---|---|---|---|---|
| Drift User (inactive) | 28,612,560 | ~22,706 | ~1,260,307 | ~34 years |
| Drift User (semi-active) | 24,812,400 | ~22,706 | ~1,092,941 | ~30 years |
| Drift User (active) | 18,826,800 | ~22,706 | ~829,194 | ~23 years |
| OpenBook BookSide | 621,242,640 | n/a — OOM | n/a | n/a |

**OpenBook caveat:** LZ4 on-chain requires an output buffer of `N + N/100 + 27` bytes on the heap.
At 90 KB input that is ~91 KB — far above the SBF 32 KB heap limit. The compression numbers
demonstrate potential rent savings but direct densol integration is not feasible at this scale.
Decompression has the same problem (output buffer = original size = 90 KB).
This is the pitch case: shows why on-chain compression matters, not a direct integration target.

**Drift accounts** are well within heap limits (4376 B raw, worst-case output ~4.5 KB).
Break-even is ~800K–1.3M reads. Even a very active user doing 100 tx/day would need
~23 years to spend back the rent saving in CU costs. Compression is a clear win for
any Drift account that lives longer than a few weeks.

## Key Takeaways

- Best case (OpenBook inactive book): **54x** — 90 KB → <2 KB, saves ~0.62 SOL per account
- Borsh inactive user: **16.5x** — 4.4 KB → 265 B
- Borsh active user: **2.6x** — 4.4 KB → 1.7 KB (worst case, still saves rent)
- Real-world data consistently compresses much better than synthetic benchmarks
