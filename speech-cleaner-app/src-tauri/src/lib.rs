use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};



#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub file_name: String,
    pub file_path: String,
    pub duration: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
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
pub struct FillerItem {
    pub id: String,
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub metadata: MediaMetadata,
    pub fillers: Vec<FillerItem>,
    pub audio_preview_path: String,
    pub peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub input_path: String,
    pub output_path: String,
    pub fillers: Vec<FillerItem>,
    pub padding_ms: f64,
    pub fade_ms: f64,
}
// ---------------------------------------------------------------------------
// Silence detection from peaks — used to correct Whisper token timestamps
// ---------------------------------------------------------------------------

/// Detect silence periods from the peaks amplitude array.
/// `min_silence_sec` = shortest gap that counts as silence (seconds).
/// Returns a list of (start_sec, end_sec) pairs.
fn find_silence_from_peaks(peaks: &[f32], duration: f64, min_silence_sec: f64) -> Vec<(f64, f64)> {
    if peaks.is_empty() || duration <= 0.0 {
        return Vec::new();
    }
    let n = peaks.len() as f64;
    let peak_max = peaks.iter().cloned().fold(0.0_f32, f32::max);
    // 6% of max or a hard floor of 0.5% — catches genuine pauses without
    // triggering on inter-phoneme micro-gaps.
    let threshold = (peak_max * 0.06).max(0.005);
    let min_pts = ((min_silence_sec * n / duration) as usize).max(1);

    let mut periods: Vec<(f64, f64)> = Vec::new();
    let mut sil_start: Option<usize> = None;

    for (i, &pk) in peaks.iter().enumerate() {
        if pk < threshold {
            if sil_start.is_none() {
                sil_start = Some(i);
            }
        } else if let Some(start_i) = sil_start.take() {
            if i - start_i >= min_pts {
                periods.push((
                    (start_i as f64 / n) * duration,
                    (i      as f64 / n) * duration,
                ));
            }
        }
    }
    // Trailing silence
    if let Some(start_i) = sil_start {
        if peaks.len() - start_i >= min_pts {
            periods.push(((start_i as f64 / n) * duration, duration));
        }
    }
    periods
}

/// Given a Whisper token (start, end), correct to the actual speech boundary.
///
/// Pattern: Whisper places the token *inside* the silence that follows the word.
/// So: find the silence containing ws → speech resumes at se → find next silence
/// start → that is the actual word end.
fn snap_filler_timestamps(
    ws: f64,
    we: f64,
    silence_periods: &[(f64, f64)],
    duration: f64,
) -> (f64, f64) {
    // Phase 1 — does ws fall inside a silence period?
    for &(ss, se) in silence_periods {
        if ws >= ss && ws < se {
            // Actual speech begins when this silence ends
            let actual_start = se;

            // Find the next silence start after actual_start — that is the word end
            let mut actual_end = (actual_start + 0.6).min(duration);
            for &(ns, _) in silence_periods {
                if ns > actual_start && ns < actual_end {
                    actual_end = ns;
                }
            }

            let actual_end = actual_end.max(actual_start + 0.05);
            return (actual_start, actual_end);
        }
    }

    // Phase 2 — ws is not in silence; trim if we overshoots into one
    for &(ss, _) in silence_periods {
        if we > ss && ws < ss {
            return (ws, ss.max(ws + 0.05));
        }
    }

    // Timestamps look fine — return as-is
    (ws, we)
}

// ---------------------------------------------------------------------------

fn resolve_paths() -> Result<(PathBuf, PathBuf), String> {
    // Check workspace root relative to execution or common dirs
    let base_candidates = vec![
        PathBuf::from(r"D:\scratch\Remove words"),
        PathBuf::from(r"."),
        std::env::current_dir().unwrap_or_default(),
    ];

    for base in base_candidates {
        let whisper_bin = base.join(r"binaries\Release\whisper-cli.exe");
        let model_path = base.join(r"models\ggml-base.en.bin");
        if whisper_bin.exists() && model_path.exists() {
            return Ok((whisper_bin, model_path));
        }
    }

    Err("Could not locate whisper-cli.exe or ggml-base.en.bin in binaries/models folder.".into())
}

#[tauri::command]
fn inspect_media(path: String) -> Result<MediaMetadata, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    let file_name = p.file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    // Probe duration
    let dur_out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            &path,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let duration: f64 = String::from_utf8_lossy(&dur_out.stdout)
        .trim()
        .parse()
        .unwrap_or(0.0);

    // Video stream info
    let v_out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,r_frame_rate",
            "-of", "default=noprint_wrappers=1",
            &path,
        ])
        .output();

    let mut video_codec = None;
    let mut width = None;
    let mut height = None;
    let mut fps = None;

    if let Ok(vout) = v_out {
        let s = String::from_utf8_lossy(&vout.stdout);
        for line in s.lines() {
            if let Some(val) = line.strip_prefix("codec_name=") {
                video_codec = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("width=") {
                width = val.parse().ok();
            } else if let Some(val) = line.strip_prefix("height=") {
                height = val.parse().ok();
            } else if let Some(val) = line.strip_prefix("r_frame_rate=") {
                let parts: Vec<&str> = val.split('/').collect();
                if parts.len() == 2 {
                    if let (Ok(num), Ok(den)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        if den > 0.0 {
                            fps = Some(num / den);
                        }
                    }
                }
            }
        }
    }

    // Audio stream info
    let a_out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,sample_rate,channels",
            "-of", "default=noprint_wrappers=1",
            &path,
        ])
        .output();

    let mut audio_codec = None;
    let mut sample_rate = None;
    let mut channels = None;

    if let Ok(aout) = a_out {
        let s = String::from_utf8_lossy(&aout.stdout);
        for line in s.lines() {
            if let Some(val) = line.strip_prefix("codec_name=") {
                audio_codec = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("sample_rate=") {
                sample_rate = val.parse().ok();
            } else if let Some(val) = line.strip_prefix("channels=") {
                channels = val.parse().ok();
            }
        }
    }

    Ok(MediaMetadata {
        file_name,
        file_path: path,
        duration,
        video_codec,
        audio_codec,
        width,
        height,
        fps,
        sample_rate,
        channels,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub percent: f64,
    pub stage: String,
}

static CANCEL_REQUESTED: Mutex<bool> = Mutex::new(false);
static ACTIVE_CHILD_PID: Mutex<Option<u32>> = Mutex::new(None);

#[tauri::command]
fn cancel_analysis() -> Result<(), String> {
    if let Ok(mut cancel) = CANCEL_REQUESTED.lock() {
        *cancel = true;
    }
    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        if let Some(pid) = *pid_guard {
            // Kill child process on Windows
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string() as &str])
                .output();
            *pid_guard = None;
        }
    }
    Ok(())
}

#[tauri::command]
fn analyze_audio(app: tauri::AppHandle, path: String) -> Result<AnalysisResult, String> {
    use tauri::Emitter;
    use std::io::{BufRead, BufReader};

    // Reset cancel state
    if let Ok(mut cancel) = CANCEL_REQUESTED.lock() {
        *cancel = false;
    }

    let emit_prog = |percent: f64, stage: &str| {
        let _ = app.emit("analysis-progress", ProgressPayload {
            percent,
            stage: stage.to_string(),
        });
    };

    emit_prog(2.0, "Inspecting media metadata...");

    let meta = inspect_media(path.clone())?;
    let (whisper_bin, model_path) = resolve_paths()?;

    let cache_dir = PathBuf::from(r"D:\scratch\Remove words\cache");
    let _ = std::fs::create_dir_all(&cache_dir);

    let temp_wav = cache_dir.join("current_analysis.wav");
    let preview_wav = cache_dir.join("current_preview.wav");
    let out_stem = cache_dir.join("whisper_res");

    emit_prog(5.0, "Extracting audio stream for AI speech model...");

    // Check cancellation
    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    // Extract 16kHz mono WAV for Whisper with progress tracking
    let mut ffmpeg_child = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &path,
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            temp_wav.to_str().unwrap(),
        ])
        .spawn()
        .map_err(|e| format!("FFmpeg analysis wav extract failed: {}", e))?;

    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        *pid_guard = Some(ffmpeg_child.id());
    }

    let ffmpeg_status = ffmpeg_child.wait()
        .map_err(|e| format!("Failed waiting for FFmpeg: {}", e))?;

    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        *pid_guard = None;
    }

    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    if !ffmpeg_status.success() {
        return Err("FFmpeg failed to extract analysis audio".into());
    }

    emit_prog(15.0, "Extracting preview audio track...");

    // Extract normalized stereo WAV for frontend playback & waveform peak extraction
    let _ = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &path,
            "-ar", "44100",
            "-ac", "2",
            "-c:a", "pcm_s16le",
            preview_wav.to_str().unwrap(),
        ])
        .output();

    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    emit_prog(20.0, "Running AI Whisper speech analysis (0%)...");

    // Determine thread count (default to 8 for fast desktop inference)
    let threads_str = "8";

    // Run Whisper with prompt biasing for maximum recall of hesitation filler words,
    // plus -pp (print-progress) to capture real-time transcription percentages.
    let mut whisper_cmd = Command::new(&whisper_bin);
    whisper_cmd.args([
        "-m", model_path.to_str().unwrap(),
        "-f", temp_wav.to_str().unwrap(),
        "-t", threads_str,
        "-ojf",
        "-of", out_stem.to_str().unwrap(),
        "-pp",
        "--prompt", "Um, uh, erm, ah, er, hesitation, filler words, stuttering, pause.",
    ]);
    whisper_cmd.stdout(std::process::Stdio::piped());
    whisper_cmd.stderr(std::process::Stdio::piped());

    let mut whisper_child = whisper_cmd.spawn()
        .map_err(|e| format!("Failed to spawn whisper: {}", e))?;

    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        *pid_guard = Some(whisper_child.id());
    }

    // Drain stdout in background thread so the process pipe never fills up and deadlocks
    if let Some(stdout) = whisper_child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for _ in reader.lines() {
                // discard or log transcript preview
            }
        });
    }

    // Read stderr line by line for -pp progress
    if let Some(stderr) = whisper_child.stderr.take() {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    // Lines like: "whisper_print_progress_callback: progress =  49%"
                    if line.contains("progress =") {
                        if let Some(pct_str) = line.split("progress =").nth(1) {
                            let clean_pct: String = pct_str.chars().filter(|c| c.is_digit(10)).collect();
                            if let Ok(num) = clean_pct.parse::<f64>() {
                                // Map 0..100% of whisper to 20%..90% of overall progress
                                let overall = 20.0 + (num / 100.0) * 70.0;
                                let _ = app_handle.emit("analysis-progress", ProgressPayload {
                                    percent: overall.min(90.0),
                                    stage: format!("AI Speech Analysis ({:.0}%)...", num),
                                });
                            }
                        }
                    }
                }
            }
        });
    }

    let whisper_res = whisper_child.wait()
        .map_err(|e| format!("Failed waiting for whisper: {}", e))?;

    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        *pid_guard = None;
    }

    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    if !whisper_res.success() {
        return Err("Whisper speech model encountered an error during inference.".into());
    }

    emit_prog(92.0, "Parsing detected speech elements...");

    let json_file = out_stem.with_extension("json");
    let json_text = std::fs::read_to_string(&json_file)
        .map_err(|e| format!("Failed to read whisper output: {}", e))?;

    let parsed: WhisperOutput = serde_json::from_str(&json_text)
        .map_err(|e| format!("Failed to parse whisper json: {}", e))?;

    // Comprehensive filler target list
    let filler_targets = [
        "um", "umm", "uh", "uhh", "erm", "err", "er", "ah", "ahh", "hmm", "hm"
    ];
    let mut fillers = Vec::new();
    let mut id_counter = 1;

    for seg in &parsed.transcription {
        let seg_trimmed = seg.text.trim().to_lowercase();
        let seg_cleaned: String = seg_trimmed.chars().filter(|c| c.is_alphabetic()).collect();

        if filler_targets.contains(&seg_cleaned.as_str()) {
            let start = seg.offsets.from as f64 / 1000.0;
            let end = seg.offsets.to as f64 / 1000.0;
            let valid_tokens: Vec<_> = seg.tokens.iter().filter(|t| !t.text.starts_with("[_")).collect();
            let avg_p = if !valid_tokens.is_empty() {
                valid_tokens.iter().map(|t| t.p).sum::<f64>() / valid_tokens.len() as f64
            } else {
                0.85
            };

            fillers.push(FillerItem {
                id: format!("filler_{}", id_counter),
                word: seg_cleaned,
                start,
                end,
                confidence: avg_p,
                enabled: true,
            });
            id_counter += 1;
            continue;
        }

        // Check tokens inside longer segment
        for tok in &seg.tokens {
            if tok.text.starts_with("[_") {
                continue;
            }
            let tok_clean: String = tok.text.trim().to_lowercase().chars().filter(|c| c.is_alphabetic()).collect();
            if filler_targets.contains(&tok_clean.as_str()) {
                let mut start = tok.offsets.from as f64 / 1000.0;
                let mut end = tok.offsets.to as f64 / 1000.0;
                // If Whisper gave a zero-length timestamp for this token, expand it slightly using segment context
                if (end - start).abs() < 0.01 {
                    end = start + 0.35;
                }
                fillers.push(FillerItem {
                    id: format!("filler_{}", id_counter),
                    word: tok_clean,
                    start,
                    end,
                    confidence: tok.p,
                    enabled: true,
                });
                id_counter += 1;
            }
        }
    }

    emit_prog(96.0, "Extracting audio waveform geometry...");

    // Extract real peak envelope from preview_wav (downsampled to 2400 points for silky smooth rendering at all zoom levels)
    let mut peaks: Vec<f32> = Vec::new();
    if let Ok(mut reader) = hound::WavReader::open(&preview_wav) {
        let spec = reader.spec();
        let channels = spec.channels.max(1) as usize;
        let total_samples = reader.len() as usize / channels;
        let target_points = 2400;
        let chunk_size = (total_samples / target_points).max(1);

        let mut current_max: f32 = 0.0;
        let mut sample_idx = 0;

        for sample in reader.samples::<i16>() {
            if let Ok(s) = sample {
                let abs_val = (s as f32).abs() / 32768.0;
                if abs_val > current_max {
                    current_max = abs_val;
                }
                sample_idx += 1;
                if sample_idx % (chunk_size * channels) == 0 {
                    peaks.push((current_max * 1.25).min(1.0));
                    current_max = 0.0;
                }
            }
        }
        if current_max > 0.0 && peaks.len() < target_points {
            peaks.push((current_max * 1.25).min(1.0));
        }
    }

    // Fallback if wav read was empty
    if peaks.is_empty() {
        peaks = vec![0.3; 200];
    }

    // -----------------------------------------------------------------------
    // Correct Whisper token timestamps using silence-period analysis.
    // Whisper's per-token timestamps are often placed inside the silence that
    // follows the word.  The actual speech onset is right after that silence.
    // -----------------------------------------------------------------------
    let silence_periods = find_silence_from_peaks(&peaks, meta.duration, 0.12);

    for filler in &mut fillers {
        let (cs, ce) = snap_filler_timestamps(
            filler.start, filler.end, &silence_periods, meta.duration
        );
        // Round to ms precision to keep display values clean
        filler.start = (cs * 1000.0).round() / 1000.0;
        filler.end   = (ce * 1000.0).round() / 1000.0;
    }

    emit_prog(100.0, "Analysis complete!");

    Ok(AnalysisResult {
        metadata: meta,
        fillers,
        audio_preview_path: preview_wav.to_string_lossy().to_string(),
        peaks,
    })
}

#[tauri::command]
fn export_video(req: ExportRequest) -> Result<String, String> {
    let input_path = Path::new(&req.input_path);
    let _output_path = Path::new(&req.output_path);

    if !input_path.exists() {
        return Err(format!("Input file does not exist: {}", req.input_path));
    }

    let enabled_fillers: Vec<_> = req.fillers.iter().filter(|f| f.enabled).collect();
    let pad_sec = req.padding_ms / 1000.0;

    let filter_expr = if enabled_fillers.is_empty() {
        "anull".to_string()
    } else {
        let conditions: Vec<String> = enabled_fillers
            .iter()
            .map(|f| {
                let s = (f.start - pad_sec).max(0.0);
                let e = f.end + pad_sec;
                format!("between(t,{:.3},{:.3})", s, e)
            })
            .collect();
        format!("volume=enable='{}':volume=0:eval=frame", conditions.join("+"))
    };

    let out = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &req.input_path,
            "-af", &filter_expr,
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            &req.output_path,
        ])
        .output()
        .map_err(|e| format!("Failed to launch ffmpeg: {}", e))?;

    if !out.status.success() {
        return Err(format!("Export failed: {}", String::from_utf8_lossy(&out.stderr)));
    }

    Ok(format!("Export complete: {}", req.output_path))
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_media,
            analyze_audio,
            cancel_analysis,
            export_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
