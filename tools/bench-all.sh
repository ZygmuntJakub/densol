#!/usr/bin/env bash
set -euo pipefail

STRATEGIES="${1:-lz4 rle identity}"

for strategy in $STRATEGIES; do
  echo "=== Strategy: $strategy ==="

  CARGO_TARGET_DIR="$PWD/target" \
    anchor build -- --no-default-features --features "$strategy,discriminant"

  BENCH_STRATEGY="$strategy" \
  CARGO_TARGET_DIR="$PWD/target" \
    anchor test --skip-build
done

echo "=== Generating charts + updating FINDINGS.md ==="
node tools/gen-charts.js --all

echo "=== Done ==="
echo "Results in results/. FINDINGS.md tables updated."
