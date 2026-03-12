/// LZ4 block compressor for the benchmark test suite.
///
/// Two modes:
///   compress_tool <SIZE>   — generate repetitive test pattern of SIZE bytes, compress it
///   compress_tool          — read raw bytes from stdin, compress them
///
/// Output: compressed bytes as hex on stdout; stats on stderr.
use densol::{Compressor, Lz4};
use std::io::Read;

fn main() {
    let data: Vec<u8> = match std::env::args().nth(1) {
        Some(size_str) => {
            let size: usize = size_str
                .parse()
                .expect("SIZE must be a positive integer");
            let pattern =
                b"Hello Solana! This is benchmark metadata for on-chain compression. ";
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
