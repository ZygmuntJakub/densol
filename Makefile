.PHONY: lint fmt fmt-check test test-scenarios bench build clean

# ── Lint & format ──────────────────────────────────────────────────────────────

# Lint the pure-Rust library only (Anchor program needs the SBF target).
# TypeScript: prettier --check (no ESLint configured).
lint:
	cargo clippy -p densol --all-targets --features chunked_lz4 -- -D warnings
	npm run lint

fmt:
	cargo fmt --all
	npm run lint:fix

fmt-check:
	cargo fmt --all -- --check
	npm run lint

# ── Tests ──────────────────────────────────────────────────────────────────────

# Pure-Rust scenario tests — no Solana CLI required
test-scenarios:
	cargo test -p densol --test scenarios --features chunked_lz4 -- --nocapture

# Unit tests for the densol crate
test:
	cargo test -p densol --all-features

# Full CU benchmark — requires local Solana validator + Anchor
bench:
	anchor test

# ── Build ──────────────────────────────────────────────────────────────────────

build:
	anchor build

clean:
	cargo clean
	rm -rf target/deploy
