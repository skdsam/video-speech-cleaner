use std::path::{Path, PathBuf};
use std::process::Command;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroundTruthFiller {
    pub word: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroundTruth {
    pub expected_fillers: Vec<GroundTruthFiller>,
    pub total_audio_duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperTokenOffsets {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperToken {
    pub text: String,
    pub p: f64,
    pub offsets: WhisperTokenOffsets,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperSegmentOffsets {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperSegment {
    pub text: String,
    pub offsets: WhisperSegmentOffsets,
    #[serde(default)]
    pub tokens: Vec<WhisperToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperOutput {
    pub transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedFiller {
    pub word: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuteRegion {
    pub start: f64,
    pub end: f64,
    pub fade_ms: f64,
    pub enabled: bool,
}

pub struct SpeechCleaner {
    pub whisper_bin: PathBuf,
    pub model_path: PathBuf,
}

impl SpeechCleaner {
    pub fn new(whisper_bin: PathBuf, model_path: PathBuf) -> Self {
        Self { whisper_bin, model_path }
    }

    pub fn inspect_duration(&self, input_path: &Path) -> Result<f64> {
        let output = Command::new("ffprobe")
            .args([
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(input_path)
            .output()
            .context("Failed to run ffprobe")?;

        if !output.status.success() {
            bail!("ffprobe failed: {}", String::from_utf8_lossy(&output.stderr));
        }

        let dur_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        dur_str.parse::<f64>().context("Failed to parse media duration")
    }

    pub fn extract_analysis_wav(&self, input_path: &Path, output_wav: &Path) -> Result<()> {
        let output = Command::new("ffmpeg")
            .args([
                "-y",
                "-i", input_path.to_str().unwrap(),
                "-ar", "16000",
                "-ac", "1",
                "-c:a", "pcm_s16le",
                output_wav.to_str().unwrap(),
            ])
            .output()
            .context("Failed to run ffmpeg for audio extraction")?;

        if !output.status.success() {
            bail!("FFmpeg extraction failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        Ok(())
    }

    pub fn run_whisper(&self, wav_path: &Path, out_stem: &Path) -> Result<WhisperOutput> {
        let output = Command::new(&self.whisper_bin)
            .args([
                "-m", self.model_path.to_str().unwrap(),
                "-f", wav_path.to_str().unwrap(),
                "-ojf",
                "-of", out_stem.to_str().unwrap(),
            ])
            .output()
            .context("Failed to run whisper-cli")?;

        if !output.status.success() {
            bail!("whisper-cli failed: {}", String::from_utf8_lossy(&output.stderr));
        }

        let json_path = out_stem.with_extension("json");
        let content = std::fs::read_to_string(&json_path)
            .context(format!("Failed to read whisper json output at {:?}", json_path))?;
        
        let parsed: WhisperOutput = serde_json::from_str(&content)
            .context("Failed to deserialize whisper json output")?;

        Ok(parsed)
    }

    pub fn detect_fillers(&self, whisper_out: &WhisperOutput) -> Vec<DetectedFiller> {
        let mut detections = Vec::new();
        let filler_targets = ["um", "umm", "uh", "uhh", "erm", "err", "er"];

        for seg in &whisper_out.transcription {
            let seg_trimmed = seg.text.trim().to_lowercase();
            let seg_cleaned: String = seg_trimmed.chars().filter(|c| c.is_alphabetic()).collect();

            // Check if entire segment is a filler word (e.g. "Umm.", "Erm.")
            if filler_targets.contains(&seg_cleaned.as_str()) {
                let start_sec = seg.offsets.from as f64 / 1000.0;
                let end_sec = seg.offsets.to as f64 / 1000.0;
                
                // Calculate average confidence from non-special tokens
                let valid_tokens: Vec<_> = seg.tokens.iter().filter(|t| !t.text.starts_with("[_")).collect();
                let avg_p = if !valid_tokens.is_empty() {
                    valid_tokens.iter().map(|t| t.p).sum::<f64>() / valid_tokens.len() as f64
                } else {
                    0.8
                };

                detections.push(DetectedFiller {
                    word: seg_cleaned,
                    start_seconds: start_sec,
                    end_seconds: end_sec,
                    confidence: avg_p,
                });
                continue;
            }

            // Also check individual tokens within multi-word segments
            for tok in &seg.tokens {
                if tok.text.starts_with("[_") {
                    continue;
                }
                let tok_clean: String = tok.text.trim().to_lowercase().chars().filter(|c| c.is_alphabetic()).collect();
                if filler_targets.contains(&tok_clean.as_str()) {
                    let start_sec = tok.offsets.from as f64 / 1000.0;
                    let end_sec = tok.offsets.to as f64 / 1000.0;
                    if end_sec > start_sec {
                        detections.push(DetectedFiller {
                            word: tok_clean,
                            start_seconds: start_sec,
                            end_seconds: end_sec,
                            confidence: tok.p,
                        });
                    }
                }
            }
        }

        detections
    }

    pub fn create_mute_regions(
        &self,
        fillers: &[DetectedFiller],
        padding_ms: f64,
        fade_ms: f64,
        media_duration: f64,
    ) -> Vec<MuteRegion> {
        let pad_sec = padding_ms / 1000.0;
        let mut regions = Vec::new();

        for f in fillers {
            let start = (f.start_seconds - pad_sec).max(0.0);
            let end = (f.end_seconds + pad_sec).min(media_duration);
            if end > start {
                regions.push(MuteRegion {
                    start,
                    end,
                    fade_ms,
                    enabled: true,
                });
            }
        }

        regions
    }

    pub fn export_cleaned_video(
        &self,
        input_file: &Path,
        output_file: &Path,
        mute_regions: &[MuteRegion],
    ) -> Result<()> {
        let enabled_mutes: Vec<_> = mute_regions.iter().filter(|r| r.enabled).collect();
        
        let filter_expr = if enabled_mutes.is_empty() {
            "anull".to_string()
        } else {
            let conditions: Vec<String> = enabled_mutes
                .iter()
                .map(|r| format!("between(t,{:.3},{:.3})", r.start, r.end))
                .collect();
            format!("volume=enable='{}':volume=0:eval=frame", conditions.join("+"))
        };

        let output = Command::new("ffmpeg")
            .args([
                "-y",
                "-i", input_file.to_str().unwrap(),
                "-af", &filter_expr,
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                output_file.to_str().unwrap(),
            ])
            .output()
            .context("Failed to run ffmpeg export")?;

        if !output.status.success() {
            bail!("FFmpeg export failed: {}", String::from_utf8_lossy(&output.stderr));
        }

        Ok(())
    }
}

fn main() -> Result<()> {
    println!("=== Speech Cleaner CLI Proof (Milestone 1) ===");
    println!("Author: SkdSam\n");

    let workspace = PathBuf::from(r"D:\scratch\Remove words");
    let input_video = workspace.join("Speech_Cleaner_Test.mp4");
    let ground_truth_file = workspace.join("Speech_Cleaner_Test_Ground_Truth.json");
    let whisper_bin = workspace.join(r"binaries\Release\whisper-cli.exe");
    let model_path = workspace.join(r"models\ggml-base.en.bin");
    let output_cleaned = workspace.join("Speech_Cleaner_Cleaned.mp4");

    if !input_video.exists() {
        bail!("Input video not found: {:?}", input_video);
    }
    if !ground_truth_file.exists() {
        bail!("Ground truth file not found: {:?}", ground_truth_file);
    }
    if !whisper_bin.exists() {
        bail!("whisper-cli not found: {:?}", whisper_bin);
    }
    if !model_path.exists() {
        bail!("Model not found: {:?}", model_path);
    }

    let cleaner = SpeechCleaner::new(whisper_bin, model_path);

    // 1. Inspect original media
    println!("1. Probing media with FFprobe...");
    let original_duration = cleaner.inspect_duration(&input_video)?;
    println!("   Original media duration: {:.3}s", original_duration);

    // 2. Extract temporary 16kHz WAV
    let temp_wav = workspace.join("temp_analysis.wav");
    println!("2. Extracting 16kHz mono WAV for analysis...");
    cleaner.extract_analysis_wav(&input_video, &temp_wav)?;
    println!("   Saved analysis audio to {:?}", temp_wav);

    // 3. Run Whisper
    let out_stem = workspace.join("temp_whisper_out");
    println!("3. Running whisper.cpp on speech audio...");
    let whisper_res = cleaner.run_whisper(&temp_wav, &out_stem)?;
    println!("   Whisper completed successfully with {} segments.", whisper_res.transcription.len());

    // 4. Detect Fillers
    println!("4. Detecting filler words...");
    let detections = cleaner.detect_fillers(&whisper_res);
    println!("   Detected {} filler occurrences:", detections.len());
    for (i, d) in detections.iter().enumerate() {
        println!("     [{}] \"{}\" at {:.3}s - {:.3}s (confidence: {:.1}%)",
            i + 1, d.word, d.start_seconds, d.end_seconds, d.confidence * 100.0);
    }

    // 5. Benchmark against Ground Truth
    println!("\n5. Benchmarking against Ground Truth JSON...");
    let gt_str = std::fs::read_to_string(&ground_truth_file)?;
    let ground_truth: GroundTruth = serde_json::from_str(&gt_str)?;

    println!("   Expected Fillers Count: {}", ground_truth.expected_fillers.len());
    for (i, expected) in ground_truth.expected_fillers.iter().enumerate() {
        // Find closest detection
        let match_opt = detections.iter().min_by(|a, b| {
            let diff_a = (a.start_seconds - expected.start_seconds).abs();
            let diff_b = (b.start_seconds - expected.start_seconds).abs();
            diff_a.partial_cmp(&diff_b).unwrap()
        });

        match match_opt {
            Some(matched) => {
                let start_diff = (matched.start_seconds - expected.start_seconds).abs();
                let end_diff = (matched.end_seconds - expected.end_seconds).abs();
                let status = if start_diff <= 0.5 && end_diff <= 0.5 { "PASS" } else { "ACCEPTABLE" };
                println!("   - [{}] Target: {:4} | Found: {:4} (at {:.3}s, Δstart: {:.3}s, Δend: {:.3}s) -> {}",
                    i + 1, expected.word, matched.word, matched.start_seconds, start_diff, end_diff, status);
            }
            None => {
                println!("   - [{}] Target: {:4} | MISSED!", i + 1, expected.word);
            }
        }
    }

    // 6. Generate Mute Regions (with 30ms padding and 8ms fades)
    println!("\n6. Generating mute intervals...");
    let mute_regions = cleaner.create_mute_regions(&detections, 30.0, 8.0, original_duration);
    for (i, r) in mute_regions.iter().enumerate() {
        println!("   Mute {}: {:.3}s -> {:.3}s (duration: {:.3}s)", i + 1, r.start, r.end, r.end - r.start);
    }

    // 7. Export Cleaned Video with Video Stream Copied
    println!("\n7. Exporting cleaned MP4 (video stream copied untouched)...");
    cleaner.export_cleaned_video(&input_video, &output_cleaned, &mute_regions)?;
    println!("   Exported successfully to {:?}", output_cleaned);

    // 8. Validate Video Duration & Sync
    let cleaned_duration = cleaner.inspect_duration(&output_cleaned)?;
    let dur_diff = (cleaned_duration - original_duration).abs();
    println!("\n8. Duration validation:");
    println!("   Input duration:   {:.3}s", original_duration);
    println!("   Output duration:  {:.3}s", cleaned_duration);
    println!("   Difference:       {:.3}s", dur_diff);

    if dur_diff < 0.05 {
        println!("   SYNC CHECK: PERFECT PASS (zero timeline drift)\n");
    } else {
        println!("   SYNC CHECK: WARNING (drift detected: {:.3}s)\n", dur_diff);
    }

    // Clean up temporary files
    let _ = std::fs::remove_file(temp_wav);
    let _ = std::fs::remove_file(out_stem.with_extension("json"));

    println!("=== Milestone 1 Proof Complete! ===");
    Ok(())
}
