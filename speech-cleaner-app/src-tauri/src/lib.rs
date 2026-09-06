mod fillers;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Manager;



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
    #[serde(default = "missing_alignment")]
    pub t_dtw: i64,
}

fn missing_alignment() -> i64 { -1 }

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
    #[serde(default)]
    pub timing_estimated: bool,
    #[serde(skip)]
    pub(crate) alignment: Option<fillers::WordAlignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub metadata: MediaMetadata,
    pub fillers: Vec<FillerItem>,
    pub audio_preview_path: String,
    pub peaks: Vec<f32>,
    pub peak_interval_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub input_path: String,
    pub output_path: String,
    pub fillers: Vec<FillerItem>,
    pub padding_ms: f64,
    pub fade_ms: f64,
}
fn resolve_paths() -> Result<(PathBuf, PathBuf), String> {
    let mut base_candidates = Vec::new();
    if let Some(dependency_dir) = std::env::var_os("SPEECH_CLEANER_DEPENDENCY_DIR") {
        base_candidates.push(PathBuf::from(dependency_dir));
    }
    // Development and regression-test fallbacks.
    base_candidates.push(PathBuf::from(".."));
    base_candidates.push(PathBuf::from("."));
    base_candidates.push(std::env::current_dir().unwrap_or_default());

    for base in base_candidates {
        let bundled_bin = base.join("binaries").join("whisper-cli.exe");
        let development_bin = base.join("binaries").join("Release").join("whisper-cli.exe");
        let whisper_bin = if bundled_bin.exists() { bundled_bin } else { development_bin };
        let model_path = ["ggml-small.en.bin", "ggml-base.en.bin"].iter()
            .map(|name| base.join("models").join(name))
            .find(|path| path.exists())
            .unwrap_or_else(|| base.join("models/ggml-small.en.bin"));
        if whisper_bin.exists() && model_path.exists() {
            return Ok((whisper_bin, model_path));
        }
    }

    Err("Could not locate whisper-cli.exe or an English model (ggml-small.en.bin or ggml-base.en.bin) in binaries/models folder.".into())
}

fn media_tool(name: &str) -> PathBuf {
    if let Some(dependency_dir) = std::env::var_os("SPEECH_CLEANER_DEPENDENCY_DIR") {
        let installed = PathBuf::from(dependency_dir).join("media").join(name);
        if installed.exists() {
            return installed;
        }
    }
    PathBuf::from(name)
}

#[tauri::command]
fn check_dependencies() -> Vec<String> {
    let root = std::env::var_os("SPEECH_CLEANER_DEPENDENCY_DIR")
        .map(PathBuf::from)
        .unwrap_or_default();
    let required = [
        ("Whisper speech engine", root.join("binaries").join("whisper-cli.exe")),
        ("English speech model", root.join("models").join("ggml-small.en.bin")),
        ("FFmpeg media engine", root.join("media").join("ffmpeg.exe")),
        ("FFprobe media inspector", root.join("media").join("ffprobe.exe")),
    ];
    required.into_iter()
        .filter_map(|(label, path)| (!path.exists()).then(|| label.to_string()))
        .collect()
}

#[tauri::command]
async fn install_dependencies(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = app.path().resource_dir()
            .map_err(|e| format!("Could not locate installer resources: {e}"))?
            .join("scripts").join("install-dependencies.ps1");
        let destination = app.path().app_local_data_dir()
            .map_err(|e| format!("Could not locate application data directory: {e}"))?
            .join("dependencies");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-InstallRoot")
            .arg(&destination)
            .output()
            .map_err(|e| format!("Could not start dependency installer: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("Dependency installation failed: {}", String::from_utf8_lossy(&output.stderr)))
        }
    }).await.map_err(|e| format!("Dependency installer task failed: {e}"))?
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
    let dur_out = Command::new(media_tool("ffprobe.exe"))
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
    let v_out = Command::new(media_tool("ffprobe.exe"))
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
    let a_out = Command::new(media_tool("ffprobe.exe"))
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
    analyze_file(path, |percent, stage| {
        let _ = app.emit("analysis-progress", ProgressPayload {
            percent, stage: stage.to_string(),
        });
    })
}

/// The desktop and the command-line regression runner share the same pipeline.
pub fn analyze_file(path: String, emit_prog: impl Fn(f64, &str)) -> Result<AnalysisResult, String> {
    use std::io::{BufRead, BufReader};

    // Reset cancel state
    if let Ok(mut cancel) = CANCEL_REQUESTED.lock() {
        *cancel = false;
    }

    emit_prog(2.0, "Inspecting media metadata...");

    let meta = inspect_media(path.clone())?;
    let (whisper_bin, model_path) = resolve_paths()?;

    let run_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let cache_dir = std::env::temp_dir().join("speech-cleaner")
        .join(format!("analysis-{}-{run_id}", std::process::id()));
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Create analysis cache: {e}"))?;

    let temp_wav = cache_dir.join("current_analysis.wav");
    let preview_wav = cache_dir.join("current_preview.wav");
    let out_stem = cache_dir.join("whisper_res");

    emit_prog(5.0, "Extracting audio stream for AI speech model...");

    // Check cancellation
    if *CANCEL_REQUESTED.lock().unwrap() {
        return Err("Analysis cancelled by user".into());
    }

    // Extract 16kHz mono WAV for Whisper with progress tracking
    let mut ffmpeg_child = Command::new(media_tool("ffmpeg.exe"))
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
    let _ = Command::new(media_tool("ffmpeg.exe"))
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
        // DTW aligns decoder tokens against audio attention. Flash attention
        // must be disabled or this CLI silently leaves t_dtw at -1.
        "-dtw", if model_path.file_name().and_then(|s| s.to_str()) == Some("ggml-small.en.bin") { "small.en" } else { "base.en" },
        "-nfa",
        // A transcript-style example preserves disfluencies. A list of keywords
        // is not a verbatim transcript, and an initial-only prompt fades on long files.
        "--carry-initial-prompt",
        "--prompt", "Umm, let me think, uh, well, erm, you know. Er, I mean, um, okay. Uh, so, umm, this is, err, an example.",
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
            emit_prog(pct, &stage);
        }

        // Check if whisper finished
        match done_rx.try_recv() {
            Ok(status) => {
                whisper_exit_status = status;
                // Drain any remaining progress events
                while let Ok((pct, stage)) = prog_rx.try_recv() {
                    emit_prog(pct, &stage);
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

    if parsed.transcription.iter().flat_map(|s| &s.tokens).any(|t| !t.text.starts_with("[_") && t.text.chars().any(char::is_alphabetic))
        && !parsed.transcription.iter().flat_map(|s| &s.tokens).any(|t| t.t_dtw >= 0) {
        return Err("Whisper did not return audio-aligned timestamps. Use a whisper-cli build supporting -dtw and -nfa.".into());
    }

    let mut fillers = fillers::detect_fillers(&parsed, meta.duration);
    emit_prog(96.0, "Aligning filler boundaries and extracting detailed waveform...");
    let peaks = fillers::refine_timestamps(&mut fillers, &temp_wav, meta.duration)?;

    emit_prog(100.0, "Analysis complete!");

    Ok(AnalysisResult {
        metadata: meta,
        fillers,
        audio_preview_path: preview_wav.to_string_lossy().to_string(),
        peaks,
        peak_interval_seconds: 0.01,
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

    let out = Command::new(media_tool("ffmpeg.exe"))
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
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            std::env::set_var("SPEECH_CLEANER_RESOURCE_DIR", resource_dir);
            let dependency_dir = app.path().app_local_data_dir()?.join("dependencies");
            std::env::set_var("SPEECH_CLEANER_DEPENDENCY_DIR", dependency_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect_media,
            check_dependencies,
            install_dependencies,
            analyze_audio,
            cancel_analysis,
            export_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
