/// LZ4 block compressor for the benchmark test suite.
///
/// Modes:
///   compress_tool <SIZE>          — generate repetitive test pattern of SIZE bytes
///   compress_tool orderbook <N>   — generate N realistic orderbook orders (80 bytes each)
///   compress_tool                 — read raw bytes from stdin
///
/// Output: compressed bytes as hex on stdout; stats on stderr.
use densol::{Compressor, Lz4};
use std::io::Read;

/// Generates N realistic orderbook orders (80 bytes each).
///
/// Each order mimics the structure of an OpenBook v2 node:
///   order_id  u128  16B — packed (price u64, seq_num u64)
///   trader    [u8;32]   — simulated pubkey (repeating pattern)
///   price     u64   8B
///   quantity  u64   8B
///   side      u8    1B
///   timestamp u64   8B
///   padding   [u8;7]    — alignment padding
fn generate_orderbook(n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n * 80);
    for i in 0..n {
        let price: u64 = 100_000 + (i as u64 % 200) * 10; // prices cluster around 100k-102k
        let seq: u64 = i as u64;
        let order_id: u128 = ((price as u128) << 64) | seq as u128;
        let trader: [u8; 32] = {
            let mut t = [0u8; 32];
            // simulate a few distinct traders cycling through
            let seed = (i % 8) as u8;
            t.iter_mut()
                .enumerate()
                .for_each(|(j, b)| *b = seed ^ (j as u8));
            t
        };
        let quantity: u64 = 1 + (i as u64 % 100);
        let side: u8 = (i % 2) as u8;
        let timestamp: u64 = 1_700_000_000 + i as u64;

        out.extend_from_slice(&order_id.to_le_bytes());
        out.extend_from_slice(&trader);
        out.extend_from_slice(&price.to_le_bytes());
        out.extend_from_slice(&quantity.to_le_bytes());
        out.push(side);
        out.extend_from_slice(&timestamp.to_le_bytes());
        out.extend_from_slice(&[0u8; 7]); // padding
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let data: Vec<u8> = match args.get(1).map(|s| s.as_str()) {
        Some("orderbook") => {
            let n: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);
            generate_orderbook(n)
        }
        Some(size_str) => {
            let size: usize = size_str.parse().expect("SIZE must be a positive integer");
            let pattern = b"Hello Solana! This is benchmark metadata for on-chain compression. ";
            pattern.iter().cycle().take(size).copied().collect()
        }
        None => {
            let mut buf = Vec::new();
            std::io::stdin()
                .read_to_end(&mut buf)
                .expect("failed to read stdin");
            buf
        }
    };

    let compressed = Lz4::compress(&data).expect("compression failed");
    let hex: String = compressed.iter().map(|b| format!("{b:02x}")).collect();
    println!("{hex}");

    eprintln!(
        "strategy={}  original={}B  compressed={}B  ratio={:.2}x",
        Lz4::NAME,
        data.len(),
        compressed.len(),
        data.len() as f64 / compressed.len() as f64,
    );
}
