// Scans files and prints masked findings: kind, file, masked preview. Never the secret.
use std::collections::BTreeMap;
fn main() {
    let mut by_kind: BTreeMap<&str, usize> = BTreeMap::new();
    let mut bytes = 0usize;
    let mut files = 0usize;
    let start = std::time::Instant::now();
    let mut slowest = (0f64, String::new());
    for path in std::env::args().skip(1) {
        let Ok(data) = std::fs::read(&path) else { continue };
        let text = String::from_utf8_lossy(&data);
        files += 1;
        bytes += data.len();
        let t = std::time::Instant::now();
        let found = secret_guard::detect::scan(&text);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if ms > slowest.0 { slowest = (ms, format!("{path} ({} KB)", data.len() / 1024)); }
        for f in found {
            *by_kind.entry(f.kind).or_default() += 1;
            let s = &text[f.start..f.end];
            let preview: String = s.chars().take(4).collect();
            let ctx_start = text[..f.start].char_indices().rev().nth(30).map(|(i, _)| i).unwrap_or(0);
            let ctx: String = text[ctx_start..f.start].chars().filter(|c| !c.is_control()).collect();
            println!("{:<28} {}…(len {}) after: {:?}  in {}", f.kind, preview, s.len(), ctx, path.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(&path));
        }
    }
    eprintln!("scanned {files} files, {:.1} MB in {:.0} ms; slowest {:.1} ms: {}", bytes as f64 / 1e6, start.elapsed().as_secs_f64() * 1000.0, slowest.0, slowest.1);
    eprintln!("{by_kind:?}");
}
