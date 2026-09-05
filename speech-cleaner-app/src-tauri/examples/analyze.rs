//! Run exactly the desktop pipeline without opening a window or exporting media.
//! cargo run --release --example analyze -- "path/to/video.mp4" result.json
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("Usage: analyze INPUT OUTPUT.json")?;
    let output = args.next().ok_or("Usage: analyze INPUT OUTPUT.json")?;
    let result = speech_cleaner_app_lib::analyze_file(path, |percent, stage| {
        eprintln!("{percent:.0}% {stage}");
    })?;
    std::fs::write(output, serde_json::to_string_pretty(&result)?)?;
    println!(
        "{} filler candidates, {} selected, {:.3}s media duration",
        result.fillers.len(),
        result.fillers.iter().filter(|f| f.enabled).count(),
        result.metadata.duration
    );
    Ok(())
}
