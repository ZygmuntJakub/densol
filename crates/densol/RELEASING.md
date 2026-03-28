# Releasing `densol`

1. Sync this crate’s sources to the canonical Git repository listed under `repository` in `Cargo.toml` (if the monorepo is not the canonical remote, mirror or subtree-push as you usually do).
2. Commit all release files with a clean working tree (`cargo publish` refuses uncommitted changes unless you pass `--allow-dirty`).
3. From the workspace root: `cargo publish -p densol`
4. After a successful publish, tag that commit (match the version in `Cargo.toml`), e.g. `git tag densol-v0.1.1 && git push origin densol-v0.1.1`

`densol-derive` is only published when its version in `crates/densol-derive/Cargo.toml` changes; this release keeps derive at **0.1.0** on crates.io.
