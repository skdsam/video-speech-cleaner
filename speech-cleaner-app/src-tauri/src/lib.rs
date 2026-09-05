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
async fn analyze_audio(app: tauri::AppHandle, path: String) -> Result<AnalysisResult, String> {
    // Delegate all blocking work to a dedicated OS thread so the main UI thread
    // (WebView2 message loop) stays free to deliver progress events to the frontend.
    tauri::async_runtime::spawn_blocking(move || analyze_audio_inner(app, path))
        .await
        .map_err(|e| format!("Async task error: {}", e))?
}

fn analyze_audio_inner(app: tauri::AppHandle, path: String) -> Result<AnalysisResult, String> {
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

    // Run Whisper with -pp (print-progress) so we can stream % to the UI,
    // and -wt 0.01 to enable word-level timestamps inside each segment JSON.
    let mut whisper_cmd = Command::new(&whisper_bin);
    whisper_cmd.args([
        "-m", model_path.to_str().unwrap(),
        "-f", temp_wav.to_str().unwrap(),
        "-t", threads_str,
        "-ojf",
        "-of", out_stem.to_str().unwrap(),
        "-pp",
        "-wt", "0.01",
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
            for _ in reader.lines() {}
        });
    }

    // Read stderr line by line for -pp progress.
    // We use a channel so the main thread can pump events while also waiting
    // for the child process — avoiding the deadlock where wait() blocks before
    // the stderr reader thread even starts.
    let (prog_tx, prog_rx) = std::sync::mpsc::channel::<(f64, String)>();

    if let Some(stderr) = whisper_child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    // whisper-cli prints: "whisper_print_progress_callback: progress = 49%"
                    // but some builds print: "progress = 49 %" — handle both
                    if line.contains("progress") && line.contains('=') {
                        if let Some(after_eq) = line.split('=').nth(1) {
                            let clean: String = after_eq.chars()
                                .take_while(|c| c.is_ascii_digit() || *c == ' ' || *c == '\t')
                                .filter(|c| c.is_ascii_digit())
                                .collect();
                            if let Ok(num) = clean.parse::<f64>() {
                                // Map whisper 0..100 → overall 20..90
                                let overall = 20.0 + (num / 100.0) * 70.0;
                                let stage = format!("AI Speech Analysis ({:.0}%)...", num);
                                let _ = prog_tx.send((overall.min(90.0), stage));
                            }
                        }
                    }
                }
            }
            // Channel drops here, receiver will see disconnected
        });
    }

    // Spawn a thread to wait for whisper and signal via a second channel
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<std::process::ExitStatus, String>>();
    let whisper_child = {
        // Move whisper_child into a Mutex so we can hand it to the wait thread
        let wc = std::sync::Mutex::new(Some(whisper_child));
        wc
    };
    let child_opt = whisper_child.lock().unwrap().take().unwrap();
    std::thread::spawn(move || {
        let res = child_opt.wait_with_output()
            .map(|o| o.status)
            .map_err(|e| e.to_string());
        let _ = done_tx.send(res);
    });

    // Drain progress events until the whisper process exits
    let whisper_exit_status: Result<std::process::ExitStatus, String>;
    loop {
        // Forward any queued progress events to the UI
        while let Ok((pct, stage)) = prog_rx.try_recv() {
            let _ = app.emit("analysis-progress", ProgressPayload {
                percent: pct,
                stage,
            });
        }

        // Check if whisper finished
        match done_rx.try_recv() {
            Ok(status) => {
                whisper_exit_status = status;
                // Drain any remaining progress events
                while let Ok((pct, stage)) = prog_rx.try_recv() {
                    let _ = app.emit("analysis-progress", ProgressPayload {
                        percent: pct,
                        stage,
                    });
                }
                break;
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                // Still running — sleep briefly then loop
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                whisper_exit_status = Err("Whisper thread disconnected unexpectedly".into());
                break;
            }
        }

        // Honour cancellation during the wait loop
        if *CANCEL_REQUESTED.lock().unwrap() {
            return Err("Analysis cancelled by user".into());
        }
    }

    if let Ok(mut pid_guard) = ACTIVE_CHILD_PID.lock() {
        *pid_guard = None;
    }

    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    let exit_ok = whisper_exit_status
        .map(|s| s.success())
        .unwrap_or(false);
    if !exit_ok {
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
    let mut fillers: Vec<FillerItem> = Vec::new();
    let mut id_counter = 1u32;

    for seg in &parsed.transcription {
        let seg_start  = seg.offsets.from as f64 / 1000.0;
        let seg_end    = seg.offsets.to   as f64 / 1000.0;
        let seg_dur    = (seg_end - seg_start).max(0.0);
        let mut found_in_tokens = false;

        // ── Layer 1: per-token scan (most precise — uses -wt word timestamps) ──
        for tok in &seg.tokens {
            if tok.text.starts_with("[_") { continue; }
            let tok_clean: String = tok.text
                .trim().to_lowercase()
                .chars().filter(|c| c.is_alphabetic()).collect();
            if !filler_targets.contains(&tok_clean.as_str()) { continue; }

            let t_start = tok.offsets.from as f64 / 1000.0;
            let mut t_end = tok.offsets.to as f64 / 1000.0;
            // Use segment start as anchor when token has no real timing
            let (start, end) = if t_start < 0.01 && t_end < 0.01 {
                (seg_start, (seg_start + 0.4).min(seg_end.max(seg_start + 0.1)))
            } else {
                if (t_end - t_start).abs() < 0.01 { t_end = t_start + 0.35; }
                (t_start, t_end)
            };

            fillers.push(FillerItem {
                id: format!("filler_{}", id_counter),
                word: tok_clean,
                start,
                end,
                confidence: tok.p,
                enabled: true,
            });
            id_counter += 1;
            found_in_tokens = true;
        }

        if found_in_tokens { continue; }

        // ── Layer 2: word-by-word text scan (catches fillers in multi-word
        //    segments when token data has no per-word timestamps) ──────────────
        let words: Vec<&str> = seg.text.split_whitespace().collect();
        let word_count = words.len() as f64;
        let mut found_in_words = false;

        for (i, word) in words.iter().enumerate() {
            let w_clean: String = word.to_lowercase()
                .chars().filter(|c| c.is_alphabetic()).collect();
            if !filler_targets.contains(&w_clean.as_str()) { continue; }

            // Distribute timing proportionally across the segment
            let frac  = i as f64 / word_count.max(1.0);
            let start = seg_start + frac * seg_dur;
            let end   = (start + 0.4).min(seg_end.max(start + 0.05));

            fillers.push(FillerItem {
                id: format!("filler_{}", id_counter),
                word: w_clean,
                start,
                end,
                // Lower confidence because timing is estimated not measured
                confidence: 0.72,
                enabled: true,
            });
            id_counter += 1;
            found_in_words = true;
        }

        if found_in_words { continue; }

        // ── Layer 3: whole-segment match (segment text IS the filler word) ────
        let seg_clean: String = seg.text.trim().to_lowercase()
            .chars().filter(|c| c.is_alphabetic()).collect();
        if filler_targets.contains(&seg_clean.as_str()) {
            let valid: Vec<_> = seg.tokens.iter()
                .filter(|t| !t.text.starts_with("[_")).collect();
            let avg_p = if !valid.is_empty() {
                valid.iter().map(|t| t.p).sum::<f64>() / valid.len() as f64
            } else { 0.85 };
            fillers.push(FillerItem {
                id: format!("filler_{}", id_counter),
                word: seg_clean,
                start: seg_start,
                end: seg_end,
                confidence: avg_p,
                enabled: true,
            });
            id_counter += 1;
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
