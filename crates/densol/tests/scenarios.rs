#![allow(clippy::type_complexity)] // test case tuples: (&str, fn(...) -> ..., bool)

use densol::{Compressor, Lz4};

// ── Data generators ───────────────────────────────────────────────────────────

fn repetitive(size: usize) -> Vec<u8> {
    // Exact pattern from compress_bench.ts: repetitive()
    let pattern = b"Hello Solana! This is benchmark metadata for on-chain compression. ";
    pattern.iter().cloned().cycle().take(size).collect()
}

fn json_like(size: usize) -> Vec<u8> {
    // Exact pattern from compress_bench.ts: jsonLike()
    let pattern = b"{\"name\":\"MyToken\",\"symbol\":\"MTK\",\"uri\":\"https://arweave.net/abc\",\"seller_fee\":500,\"creators\":[{\"address\":\"So11111111111111111111111111111111111111112\",\"share\":100}]}";
    pattern.iter().cloned().cycle().take(size).collect()
}

fn pseudo_random(size: usize) -> Vec<u8> {
    // LCG matching the TypeScript algorithm: seed=0xdeadbeef, take top byte each step.
    let mut s: u32 = 0xdeadbeef;
    (0..size)
        .map(|_| {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            (s >> 24) as u8
        })
        .collect()
}

fn orderbook(size: usize) -> Vec<u8> {
    // 80-byte synthetic order entry: 8B price LE f64 + 8B qty LE f64 + 1B side + 63B zeros.
    let mut entry = [0u8; 80];
    entry[0..8].copy_from_slice(&1234.5678_f64.to_le_bytes());
    entry[8..16].copy_from_slice(&100.0_f64.to_le_bytes());
    entry[16] = 0x01; // side: bid; remaining 63 bytes are already zero
    entry.iter().cloned().cycle().take(size).collect()
}

// ── Rent saving formula ───────────────────────────────────────────────────────

const LAMPORTS_PER_BYTE: i64 = 6960;

fn rent_saving(original: usize, compressed: usize) -> i64 {
    (original as i64 - compressed as i64) * LAMPORTS_PER_BYTE
}

// ── Formatting helpers ────────────────────────────────────────────────────────

fn fmt_lamports(l: i64) -> String {
    let sign = if l >= 0 { "+" } else { "-" };
    let digits = l.unsigned_abs().to_string();
    let mut with_commas = String::new();
    for (i, c) in digits.chars().rev().enumerate() {
        if i != 0 && i % 3 == 0 {
            with_commas.push(',');
        }
        with_commas.push(c);
    }
    let rev: String = with_commas.chars().rev().collect();
    format!("{}{} L", sign, rev)
}

// ── lz4_write_sizes ───────────────────────────────────────────────────────────

#[test]
fn lz4_write_sizes() {
    println!("\n=== Lz4 — write scenarios ===");
    println!(
        "{:<14} {:>8} {:>12} {:>7} {:>18}",
        "type", "size", "compressed", "ratio", "rent_saving"
    );

    let sizes: &[usize] = &[256, 512, 800];

    // (name, generator, assert_compresses)
    let cases: &[(&str, fn(usize) -> Vec<u8>, bool)] = &[
        ("repetitive", repetitive, true),
        ("json-like", json_like, true),
        ("pseudo-random", pseudo_random, false),
        ("orderbook", orderbook, false),
    ];

    for &size in sizes {
        for &(name, gen, assert_compresses) in cases {
            let input = gen(size);
            let compressed = Lz4::compress(&input).unwrap();
            let decompressed = Lz4::decompress(&compressed).unwrap();
            assert_eq!(decompressed, input, "{name} {size}B roundtrip failed");
            if assert_compresses {
                assert!(
                    compressed.len() < input.len(),
                    "{name} {size}B should compress: compressed={} original={}",
                    compressed.len(),
                    input.len()
                );
            }
            let ratio = input.len() as f64 / compressed.len() as f64;
            let saving = rent_saving(input.len(), compressed.len());
            println!(
                "{:<14} {:>6} B {:>10} B {:>6.2}x {:>18}",
                name,
                size,
                compressed.len(),
                ratio,
                fmt_lamports(saving),
            );
        }
    }
}

// ── lz4_read_sizes ────────────────────────────────────────────────────────────

#[test]
fn lz4_read_sizes() {
    println!("\n=== Lz4 — read scenarios ===");
    println!(
        "{:<14} {:>8} {:>12} {:>7} {:>18}",
        "type", "size", "compressed", "ratio", "rent_saving"
    );

    let sizes: &[usize] = &[256, 512, 1_024, 2_048, 4_096, 8_192, 10_240];

    let cases: &[(&str, fn(usize) -> Vec<u8>, bool)] = &[
        ("repetitive", repetitive, true),
        ("json-like", json_like, true),
        ("pseudo-random", pseudo_random, false),
        ("orderbook", orderbook, false),
    ];

    for &size in sizes {
        for &(name, gen, assert_compresses) in cases {
            let input = gen(size);
            let compressed = Lz4::compress(&input).unwrap();
            let decompressed = Lz4::decompress(&compressed).unwrap();
            assert_eq!(decompressed, input, "{name} {size}B roundtrip failed");
            if assert_compresses {
                assert!(
                    compressed.len() < input.len(),
                    "{name} {size}B should compress: compressed={} original={}",
                    compressed.len(),
                    input.len()
                );
            }
            let ratio = input.len() as f64 / compressed.len() as f64;
            let saving = rent_saving(input.len(), compressed.len());
            println!(
                "{:<14} {:>6} B {:>10} B {:>6.2}x {:>18}",
                name,
                size,
                compressed.len(),
                ratio,
                fmt_lamports(saving),
            );
        }
    }
}

// ── chunked_lz4_large ─────────────────────────────────────────────────────────

#[cfg(feature = "chunked_lz4")]
#[test]
fn chunked_lz4_large() {
    use densol::ChunkedLz4;

    println!("\n=== ChunkedLz4<4096> — large scenarios ===");
    println!(
        "{:<14} {:>10} {:>12} {:>7} {:>7} {:>18}",
        "type", "size", "compressed", "ratio", "chunks", "rent_saving"
    );

    let sizes: &[usize] = &[
        32_768, 65_536, 92_160, 262_144, 524_288, 1_048_576, 4_194_304,
    ];

    let cases: &[(&str, fn(usize) -> Vec<u8>)] = &[
        ("repetitive", repetitive),
        ("json-like", json_like),
        ("pseudo-random", pseudo_random),
        ("orderbook", orderbook),
    ];

    for &size in sizes {
        for &(name, gen) in cases {
            let input = gen(size);
            let compressed = ChunkedLz4::<4096>::compress(&input).unwrap();

            // Full round-trip
            let decompressed = ChunkedLz4::<4096>::decompress(&compressed).unwrap();
            assert_eq!(decompressed, input, "{name} {size}B full roundtrip failed");

            // Per-chunk correctness — spot-check large inputs to avoid O(1024) checks at 4 MB
            let chunk_count = ChunkedLz4::<4096>::chunk_count(&compressed).unwrap();
            let indices: Vec<usize> = if size <= 131_072 {
                (0..chunk_count).collect()
            } else {
                vec![0, chunk_count / 2, chunk_count - 1]
            };
            for i in indices {
                let chunk = ChunkedLz4::<4096>::decompress_chunk(&compressed, i).unwrap();
                let start = i * 4096;
                let end = (start + 4096).min(input.len());
                assert_eq!(
                    chunk,
                    input[start..end],
                    "{name} {size}B chunk {i} mismatch"
                );
            }

            let ratio = input.len() as f64 / compressed.len() as f64;
            let saving = rent_saving(input.len(), compressed.len());
            let sol = saving.abs() as f64 / 1_000_000_000.0;
            println!(
                "{:<14} {:>8} B {:>10} B {:>6.2}x {:>6}  {} (~{:.1} SOL)",
                name,
                size,
                compressed.len(),
                ratio,
                chunk_count,
                fmt_lamports(saving),
                sol,
            );
        }
    }
}

// ── chunked_lz4_chunk_size_variants ──────────────────────────────────────────

#[cfg(feature = "chunked_lz4")]
#[test]
fn chunked_lz4_chunk_size_variants() {
    use densol::ChunkedLz4;

    println!("\n=== ChunkedLz4 — chunk size variants (90 KB orderbook) ===");
    println!(
        "{:<12} {:>12} {:>7} {:>7}",
        "chunk_size", "compressed", "ratio", "chunks"
    );

    let size = 92_160usize; // 90 KB — OpenBook BookSide scale
    let input = orderbook(size);

    let buf_512 = ChunkedLz4::<512>::compress(&input).unwrap();
    let buf_1024 = ChunkedLz4::<1024>::compress(&input).unwrap();
    let buf_4096 = ChunkedLz4::<4096>::compress(&input).unwrap();

    // Cross-decompress: any M can decompress data produced by any N.
    assert_eq!(
        ChunkedLz4::<4096>::decompress(&buf_512).unwrap(),
        input,
        "512→4096 failed"
    );
    assert_eq!(
        ChunkedLz4::<4096>::decompress(&buf_1024).unwrap(),
        input,
        "1024→4096 failed"
    );
    assert_eq!(
        ChunkedLz4::<512>::decompress(&buf_4096).unwrap(),
        input,
        "4096→512 failed"
    );
    assert_eq!(
        ChunkedLz4::<1024>::decompress(&buf_4096).unwrap(),
        input,
        "4096→1024 failed"
    );
    assert_eq!(
        ChunkedLz4::<512>::decompress(&buf_1024).unwrap(),
        input,
        "1024→512 failed"
    );
    assert_eq!(
        ChunkedLz4::<1024>::decompress(&buf_512).unwrap(),
        input,
        "512→1024 failed"
    );

    // Chunk counts must equal ceil(size / N) for each N.
    let count_512 = ChunkedLz4::<512>::chunk_count(&buf_512).unwrap();
    let count_1024 = ChunkedLz4::<1024>::chunk_count(&buf_1024).unwrap();
    let count_4096 = ChunkedLz4::<4096>::chunk_count(&buf_4096).unwrap();

    assert_eq!(
        count_512,
        size.div_ceil(512),
        "chunk count mismatch for N=512"
    );
    assert_eq!(
        count_1024,
        size.div_ceil(1024),
        "chunk count mismatch for N=1024"
    );
    assert_eq!(
        count_4096,
        size.div_ceil(4096),
        "chunk count mismatch for N=4096"
    );

    for (chunk_size, buf, count) in [
        (512usize, &buf_512, count_512),
        (1024, &buf_1024, count_1024),
        (4096, &buf_4096, count_4096),
    ] {
        let ratio = size as f64 / buf.len() as f64;
        println!(
            "{:<12} {:>10} B {:>6.2}x {:>6}",
            chunk_size,
            buf.len(),
            ratio,
            count,
        );
    }
}
