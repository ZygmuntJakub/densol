/// Quick size comparison: Lz4 vs Lz4Huffman on benchmark-like datasets.
/// Run with: cargo run --example huff_sizes --features lz4_huffman,chunked_lz4 -p densol

use densol::{Compressor, Lz4, Lz4Huffman};

fn make_repetitive(n: usize) -> Vec<u8> {
    let tile = b"the quick brown fox jumps over the lazy dog_____________________";
    tile.iter().cloned().cycle().take(n).collect()
}

fn make_json_like(n: usize) -> Vec<u8> {
    let tile = b"{\"lamports\":1000000,\"owner\":\"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\",\"executable\":false,\"rentEpoch\":0}";
    tile.iter().cloned().cycle().take(n).collect()
}

fn make_pseudo_random(n: usize) -> Vec<u8> {
    let mut state: u64 = 0x123456789ABCDEF0;
    (0..n).map(|_| { state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (state >> 33) as u8 }).collect()
}

fn make_orderbook(n: usize) -> Vec<u8> {
    // 80-byte entry: price f64 + qty f64 + side u8 + 63 zeros
    let mut v = Vec::with_capacity(n);
    let mut i = 0usize;
    while v.len() < n {
        let price: f64 = 150.0 + (i % 1000) as f64 * 0.01;
        let qty: f64 = 1.0 + (i % 100) as f64 * 0.1;
        let side: u8 = (i % 2) as u8;
        v.extend_from_slice(&price.to_le_bytes());
        v.extend_from_slice(&qty.to_le_bytes());
        v.push(side);
        v.extend_from_slice(&[0u8; 63]);
        i += 1;
    }
    v.truncate(n);
    v
}

fn report(label: &str, size: usize, input: &[u8]) {
    let lz4 = Lz4::compress(input).unwrap();
    let huff = Lz4Huffman::compress(input).unwrap();
    let flag = huff[1]; // after discriminant byte
    let flag_str = if flag == 0 { "RAW" } else { "HUFFMAN" };
    let lz4_ratio = size as f64 / lz4.len() as f64;
    let huff_ratio = size as f64 / huff.len() as f64;
    let improvement = lz4.len() as i64 - huff.len() as i64;
    println!(
        "{:<30} {:>6}B raw  lz4={:>5}B ({:.2}x)  huff={:>5}B ({:.2}x)  delta={:>+5}B  [{}]",
        label, size, lz4.len(), lz4_ratio, huff.len(), huff_ratio, improvement, flag_str
    );
}

fn main() {
    println!("{:<30} {:>6}   {:>14}  {:>14}  {:>9}  flag", "dataset+size", "raw", "lz4", "huffman", "delta");
    println!("{}", "-".repeat(95));

    for &sz in &[256usize, 512, 800, 1024, 2048, 4096, 8192, 10240] {
        report(&format!("repetitive {sz}B"),    sz, &make_repetitive(sz));
        report(&format!("json-like {sz}B"),     sz, &make_json_like(sz));
        report(&format!("pseudo-random {sz}B"), sz, &make_pseudo_random(sz));
        report(&format!("orderbook {sz}B"),     sz, &make_orderbook(sz));
        println!();
    }
}
