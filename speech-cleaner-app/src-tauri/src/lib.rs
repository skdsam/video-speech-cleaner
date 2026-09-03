use std::path::{Path, PathBuf};
use std::process::Command;
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

#[tauri::command]
fn analyze_audio(path: String) -> Result<AnalysisResult, String> {
    let meta = inspect_media(path.clone())?;
    let (whisper_bin, model_path) = resolve_paths()?;

    let cache_dir = PathBuf::from(r"D:\scratch\Remove words\cache");
    let _ = std::fs::create_dir_all(&cache_dir);

    let temp_wav = cache_dir.join("current_analysis.wav");
    let preview_wav = cache_dir.join("current_preview.wav");
    let out_stem = cache_dir.join("whisper_res");

    // Extract 16kHz mono WAV for Whisper
    let ext_out = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &path,
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            temp_wav.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("FFmpeg analysis wav extract failed: {}", e))?;

    if !ext_out.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&ext_out.stderr)));
    }

    // Extract normalized stereo WAV for frontend playback & waveform
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

    // Run Whisper
    let whisper_res = Command::new(&whisper_bin)
        .args([
            "-m", model_path.to_str().unwrap(),
            "-f", temp_wav.to_str().unwrap(),
            "-ojf",
            "-of", out_stem.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("Failed to run whisper: {}", e))?;

    if !whisper_res.status.success() {
        return Err(format!("Whisper error: {}", String::from_utf8_lossy(&whisper_res.stderr)));
    }

    let json_file = out_stem.with_extension("json");
    let json_text = std::fs::read_to_string(&json_file)
        .map_err(|e| format!("Failed to read whisper output: {}", e))?;

    let parsed: WhisperOutput = serde_json::from_str(&json_text)
        .map_err(|e| format!("Failed to parse whisper json: {}", e))?;

    // Filler targets
    let filler_targets = ["um", "umm", "uh", "uhh", "erm", "err", "er"];
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
                let start = tok.offsets.from as f64 / 1000.0;
                let end = tok.offsets.to as f64 / 1000.0;
                if end > start {
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
    }

    Ok(AnalysisResult {
        metadata: meta,
        fillers,
        audio_preview_path: preview_wav.to_string_lossy().to_string(),
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

#[tauri::command]
fn play_audio_snippet(path: String, start: f64, duration: f64) -> Result<(), String> {
    // Kill any existing ffplay instance
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "ffplay.exe"])
        .output();

    let cache_dir = PathBuf::from(r"D:\scratch\Remove words\cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    let snippet_wav = cache_dir.join("preview_snippet.wav");

    let start_str = format!("{:.3}", start.max(0.0));
    let dur_str = format!("{:.3}", duration.max(0.1));

    // Extract exact snippet using ffmpeg for sample-accurate playback
    let ext = Command::new("ffmpeg")
        .args([
            "-y",
            "-ss", &start_str,
            "-t", &dur_str,
            "-i", &path,
            "-vn",
            "-c:a", "pcm_s16le",
            snippet_wav.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("FFmpeg snippet extract failed: {}", e))?;

    if !ext.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&ext.stderr)));
    }

    // Play extracted snippet using ffplay
    let mut cmd = Command::new("ffplay");
    cmd.args([
        "-nodisp",
        "-autoexit",
        snippet_wav.to_str().unwrap(),
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to spawn audio preview: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_media,
            analyze_audio,
            export_video,
            play_audio_snippet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
