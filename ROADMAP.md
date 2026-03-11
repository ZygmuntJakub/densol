# densol — ROADMAP

## Algorithm research (heatshrink / lzss)

LZ4 needs `N + output(N)` heap, capping on-chain compress at ~15 KB (random) / ~30 KB (structured). Two smaller-footprint LZSS candidates to evaluate:

| | heatshrink | lzss crate |
|---|---|---|
| Source | C lib by Scott Vokes (MIT); Rust ports exist | `lzss` on crates.io |
| Heap | ~512 B stack-allocated at default config | 4 KB default, down to 256 B via `const` |
| SBF | Likely — needs `no_std` port audit | Probable — needs heap audit for `Box` allocs |
| Task | Add `densol::Heatshrink`, benchmark vs LZ4 | Add `lzss` feature flag, benchmark vs LZ4 |
