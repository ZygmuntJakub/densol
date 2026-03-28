# Changelog

## 0.1.1

- Add optional `chunked_lz4` feature: `ChunkedLz4`, per-chunk decompression, and `lz4_compress_chunk` / `LZ4_HASH_TABLE_WORDS` for SBF-friendly compression (single reused hash table vs per-chunk allocations).
- Require `lz4_flex` **≥ 0.11.6** (avoids yanked 0.11.5).
- Set `documentation` metadata for docs.rs.

Release checklist: tag the published commit on the canonical repository (e.g. `densol-v0.1.1`).
