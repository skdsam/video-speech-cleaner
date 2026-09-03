import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

interface MediaMetadata {
  file_name: String;
  file_path: String;
  duration: number;
  video_codec?: string;
  audio_codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  sample_rate?: number;
  channels?: number;
}

interface FillerItem {
  id: string;
  word: string;
  start: number;
  end: number;
  confidence: number;
  enabled: boolean;
}

interface AnalysisResult {
  metadata: MediaMetadata;
  fillers: FillerItem[];
  audio_preview_path: string;
}

let currentMetadata: MediaMetadata | null = null;
let currentFillers: FillerItem[] = [];

// DOM Elements
const dropSection = document.getElementById("dropSection") as HTMLElement;
const selectFileBtn = document.getElementById("selectFileBtn") as HTMLButtonElement;
const mediaCard = document.getElementById("mediaCard") as HTMLElement;
const metaFileName = document.getElementById("metaFileName") as HTMLElement;
const chipDuration = document.getElementById("chipDuration") as HTMLElement;
const chipResolution = document.getElementById("chipResolution") as HTMLElement;
const chipVideoCodec = document.getElementById("chipVideoCodec") as HTMLElement;
const chipAudioCodec = document.getElementById("chipAudioCodec") as HTMLElement;
const chipSampleRate = document.getElementById("chipSampleRate") as HTMLElement;
const changeFileBtn = document.getElementById("changeFileBtn") as HTMLButtonElement;
const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement;

const progressSection = document.getElementById("progressSection") as HTMLElement;
const progressStatus = document.getElementById("progressStatus") as HTMLElement;
const progressPercent = document.getElementById("progressPercent") as HTMLElement;
const progressBar = document.getElementById("progressBar") as HTMLElement;

const waveformSection = document.getElementById("waveformSection") as HTMLElement;
const waveformCanvas = document.getElementById("waveformCanvas") as HTMLCanvasElement;

const reviewSection = document.getElementById("reviewSection") as HTMLElement;
const reviewSubtext = document.getElementById("reviewSubtext") as HTMLElement;
const detectionList = document.getElementById("detectionList") as HTMLElement;
const selectAllBtn = document.getElementById("selectAllBtn") as HTMLButtonElement;
const deselectAllBtn = document.getElementById("deselectAllBtn") as HTMLButtonElement;
const selectConfidentBtn = document.getElementById("selectConfidentBtn") as HTMLButtonElement;

const paramsSection = document.getElementById("paramsSection") as HTMLElement;
const exportBar = document.getElementById("exportBar") as HTMLElement;
const summaryMuteCount = document.getElementById("summaryMuteCount") as HTMLElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;

// File picker event
selectFileBtn.addEventListener("click", async () => {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Video and Audio",
          extensions: ["mp4", "mov", "mkv", "webm", "avi", "wav", "mp3", "m4a", "flac"]
        }
      ]
    });

    if (selected && typeof selected === "string") {
      loadMediaFile(selected);
    }
  } catch (err) {
    console.error("Open file error:", err);
    // Fallback: If running in standalone browser test
    fallbackPromptFile();
  }
});

changeFileBtn.addEventListener("click", () => {
  selectFileBtn.click();
});

function fallbackPromptFile() {
  const path = prompt("Enter full video file path to test (e.g. D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4):", "D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4");
  if (path) {
    loadMediaFile(path);
  }
}

// Drag & drop support
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  // Tauri file drop handles this natively or via prompt
});

async function loadMediaFile(filePath: string) {
  try {
    dropSection.style.display = "none";
    mediaCard.style.display = "flex";

    const meta = await invoke<MediaMetadata>("inspect_media", { path: filePath });
    currentMetadata = meta;

    metaFileName.innerText = meta.file_name.toString();
    chipDuration.innerText = `Duration: ${formatTime(meta.duration)}`;
    chipResolution.innerText = meta.width && meta.height ? `${meta.width}x${meta.height}` : "Audio Only";
    chipVideoCodec.innerText = meta.video_codec ? `Video: ${meta.video_codec}` : "No Video Stream";
    chipAudioCodec.innerText = meta.audio_codec ? `Audio: ${meta.audio_codec}` : "Unknown Audio";
    chipSampleRate.innerText = meta.sample_rate ? `${(meta.sample_rate / 1000).toFixed(1)} kHz` : "";

    // Reset review states
    reviewSection.style.display = "none";
    waveformSection.style.display = "none";
    paramsSection.style.display = "none";
    exportBar.style.display = "none";
  } catch (e: any) {
    alert("Error inspecting file: " + (e.message || e));
    dropSection.style.display = "flex";
    mediaCard.style.display = "none";
  }
}

// Analysis action
analyzeBtn.addEventListener("click", async () => {
  if (!currentMetadata) return;

  try {
    analyzeBtn.disabled = true;
    progressSection.style.display = "flex";
    progressStatus.innerText = "Extracting audio & running local whisper.cpp...";
    progressPercent.innerText = "50%";
    progressBar.style.width = "50%";

    const result = await invoke<AnalysisResult>("analyze_audio", { path: currentMetadata.file_path });
    currentFillers = result.fillers;

    progressPercent.innerText = "100%";
    progressBar.style.width = "100%";
    setTimeout(() => {
      progressSection.style.display = "none";
      displayDetections();
    }, 400);
  } catch (err: any) {
    alert("Analysis failed: " + (err.message || err));
    progressSection.style.display = "none";
  } finally {
    analyzeBtn.disabled = false;
  }
});

function displayDetections() {
  waveformSection.style.display = "flex";
  reviewSection.style.display = "block";
  paramsSection.style.display = "flex";
  exportBar.style.display = "flex";

  reviewSubtext.innerText = `Found ${currentFillers.length} filler sound occurrences. Toggle or preview below.`;
  renderFillersList();
  renderWaveform();
  updateSummary();
}

function renderFillersList() {
  detectionList.innerHTML = "";

  currentFillers.forEach((item) => {
    const el = document.createElement("div");
    el.className = `detection-item ${item.enabled ? "" : "disabled"}`;

    const dur = item.end - item.start;
    const confPct = Math.round(item.confidence * 100);

    el.innerHTML = `
      <div class="detection-left">
        <label class="checkbox-container">
          <input type="checkbox" ${item.enabled ? "checked" : ""} data-id="${item.id}" />
          <span class="checkmark"></span>
        </label>
        <span class="filler-badge">${item.word}</span>
        <div class="detection-timestamps">
          <span>${formatTime(item.start)} → ${formatTime(item.end)}</span>
        </div>
        <span class="detection-duration">(${dur.toFixed(2)}s)</span>
      </div>
      <div class="detection-right">
        <span class="confidence-indicator">${confPct}% confidence</span>
        <button class="btn-preview" data-start="${item.start}" data-end="${item.end}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
      </div>
    `;

    // Toggle event
    const cb = el.querySelector("input") as HTMLInputElement;
    cb.addEventListener("change", () => {
      item.enabled = cb.checked;
      el.className = `detection-item ${item.enabled ? "" : "disabled"}`;
      updateSummary();
      renderWaveform();
    });

    // Preview event
    const prevBtn = el.querySelector(".btn-preview") as HTMLButtonElement;
    prevBtn.addEventListener("click", () => {
      previewRegion(item.start, item.end);
    });

    detectionList.appendChild(el);
  });
}

function updateSummary() {
  const activeCount = currentFillers.filter(f => f.enabled).length;
  summaryMuteCount.innerText = activeCount.toString();
}

// Bulk Selection
selectAllBtn.addEventListener("click", () => {
  currentFillers.forEach(f => f.enabled = true);
  renderFillersList();
  updateSummary();
  renderWaveform();
});

deselectAllBtn.addEventListener("click", () => {
  currentFillers.forEach(f => f.enabled = false);
  renderFillersList();
  updateSummary();
  renderWaveform();
});

selectConfidentBtn.addEventListener("click", () => {
  currentFillers.forEach(f => {
    f.enabled = f.confidence >= 0.75;
  });
  renderFillersList();
  updateSummary();
  renderWaveform();
});

// Audio Preview with custom gain/mute preview simulation
function previewRegion(start: number, end: number) {
  if (!currentMetadata) return;
  // If previewAudio has a valid src, play snippet with 1s pre-roll
  const playStart = Math.max(0, start - 1.0);
  const playEnd = Math.min(currentMetadata.duration, end + 1.0);

  // In desktop app, play the preview snippet
  console.log(`Previewing filler: ${start.toFixed(2)}s to ${end.toFixed(2)}s (window: ${playStart.toFixed(2)}s - ${playEnd.toFixed(2)}s)`);
}

// Waveform rendering
function renderWaveform() {
  const ctx = waveformCanvas.getContext("2d");
  if (!ctx || !currentMetadata) return;

  const width = (waveformCanvas.width = waveformCanvas.offsetWidth);
  const height = (waveformCanvas.height = waveformCanvas.offsetHeight);
  const duration = currentMetadata.duration || 1;

  ctx.clearRect(0, 0, width, height);

  // Draw simulated soundwave bars
  const barCount = 180;
  const barWidth = width / barCount;
  ctx.fillStyle = "#334155";

  for (let i = 0; i < barCount; i++) {
    // Generate pseudo wave amplitude
    const progress = i / barCount;
    const amp = Math.sin(progress * Math.PI * 4) * 0.3 + 0.5 + Math.random() * 0.2;
    const barH = amp * (height * 0.7);
    const y = (height - barH) / 2;
    ctx.fillRect(i * barWidth, y, barWidth - 1, barH);
  }

  // Draw overlay mute zones for active fillers
  currentFillers.forEach(f => {
    const startX = (f.start / duration) * width;
    const endX = (f.end / duration) * width;
    const zoneW = Math.max(endX - startX, 4);

    if (f.enabled) {
      // Red muted zone
      ctx.fillStyle = "rgba(244, 63, 94, 0.4)";
      ctx.fillRect(startX, 0, zoneW, height);

      ctx.strokeStyle = "#F43F5E";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(startX, 0, zoneW, height);

      // Label
      ctx.fillStyle = "#FFF";
      ctx.font = "bold 10px JetBrains Mono";
      ctx.fillText(f.word.toUpperCase(), startX + 2, 14);
    } else {
      // Disabled (gray)
      ctx.fillStyle = "rgba(100, 116, 139, 0.2)";
      ctx.fillRect(startX, 0, zoneW, height);
    }
  });
}

// Export cleaned file
exportBtn.addEventListener("click", async () => {
  if (!currentMetadata) return;

  try {
    const ext = currentMetadata.file_name.toString().split('.').pop() || "mp4";
    const defaultOutput = currentMetadata.file_path.toString().replace(`.${ext}`, `_cleaned.${ext}`);

    let savePath: string | null = null;
    try {
      savePath = await save({
        defaultPath: defaultOutput,
        filters: [
          {
            name: "Video / Audio",
            extensions: [ext]
          }
        ]
      });
    } catch {
      savePath = defaultOutput;
    }

    if (!savePath) return;

    exportBtn.disabled = true;
    exportBtn.innerText = "Exporting Cleaned Video...";

    const paddingMs = parseFloat((document.getElementById("paramPaddingBefore") as HTMLInputElement).value) || 30;
    const fadeMs = parseFloat((document.getElementById("paramFade") as HTMLInputElement).value) || 8;

    const res = await invoke<string>("export_video", {
      req: {
        input_path: currentMetadata.file_path,
        output_path: savePath,
        fillers: currentFillers,
        padding_ms: paddingMs,
        fade_ms: fadeMs
      }
    });

    alert(res);
  } catch (err: any) {
    alert("Export failed: " + (err.message || err));
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerText = "Export Cleaned Video";
  }
});

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins < 10 ? '0' : ''}${mins}:${parseFloat(secs) < 10 ? '0' : ''}${secs}`;
}

// Automatically load the test file if present
window.addEventListener("DOMContentLoaded", () => {
  const testFile = "D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4";
  loadMediaFile(testFile);
});
