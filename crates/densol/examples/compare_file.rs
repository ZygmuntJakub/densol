/// Compare Lz4 vs Lz4Huffman on a binary file passed as argv[1].
/// Usage: cargo run --example compare_file --features lz4_huffman,chunked_lz4 -p densol --release -- /tmp/file.bin
use densol::{Compressor, Lz4, Lz4Huffman};
use std::io::Read;

fn main() {
    let path = std::env::args().nth(1).expect("usage: compare_file <path>");
    let mut raw = Vec::new();
    std::fs::File::open(&path).unwrap().read_to_end(&mut raw).unwrap();

    let lz4 = Lz4::compress(&raw).unwrap();
    let huff = Lz4Huffman::compress(&raw).unwrap();
    let flag = huff[1];

    println!("file:     {path}");
    println!("raw:      {} B", raw.len());
    println!("lz4:      {} B  ({:.2}x)", lz4.len(), raw.len() as f64 / lz4.len() as f64);
    println!(
        "lz4+huff: {} B  ({:.2}x)  [{}]  delta={:+} B",
        huff.len(),
        raw.len() as f64 / huff.len() as f64,
        if flag == 0 { "RAW" } else { "HUFFMAN" },
        lz4.len() as i64 - huff.len() as i64
    );

    // Verify roundtrip
    assert_eq!(Lz4Huffman::decompress(&huff).unwrap(), raw, "roundtrip failed!");
    println!("roundtrip: OK");
}
