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

// Interactive Transport and Scrubbing State
let isPlaying = false;
let currentTime = 0;
let playbackStartTimestamp = 0;
let playbackStartOffset = 0;
let animationFrameId: number | null = null;
let isDraggingTimeline = false;
let isSelectingWaveform = false;
let selectionStartX = 0;
let selectionCurrentX = 0;

// Transport Elements
const currentTimeDisplay = document.getElementById("currentTimeDisplay") as HTMLElement;
const totalTimeDisplay = document.getElementById("totalTimeDisplay") as HTMLElement;
const waveformContainer = document.getElementById("waveformContainer") as HTMLElement;
const playheadLine = document.getElementById("playheadLine") as HTMLElement;
const timelineSelection = document.getElementById("timelineSelection") as HTMLElement;
const timelineHoverTooltip = document.getElementById("timelineHoverTooltip") as HTMLElement;
const transportPlayBtn = document.getElementById("transportPlayBtn") as HTMLButtonElement;
const transportPlayIcon = document.getElementById("transportPlayIcon") as unknown as SVGElement;
const transportPlayText = document.getElementById("transportPlayText") as HTMLElement;
const transportStopBtn = document.getElementById("transportStopBtn") as HTMLButtonElement;
const transportBackBtn = document.getElementById("transportBackBtn") as HTMLButtonElement;
const transportFwdBtn = document.getElementById("transportFwdBtn") as HTMLButtonElement;
const timelineScrubber = document.getElementById("timelineScrubber") as HTMLInputElement;

// Manual Add Elements
const openAddCustomModalBtn = document.getElementById("openAddCustomModalBtn") as HTMLButtonElement;
const manualAddPanel = document.getElementById("manualAddPanel") as HTMLElement;
const manualWordInput = document.getElementById("manualWordInput") as HTMLInputElement;
const manualStartInput = document.getElementById("manualStartInput") as HTMLInputElement;
const manualEndInput = document.getElementById("manualEndInput") as HTMLInputElement;
const btnSetStartCurrent = document.getElementById("btnSetStartCurrent") as HTMLButtonElement;
const btnSetEndCurrent = document.getElementById("btnSetEndCurrent") as HTMLButtonElement;
const btnConfirmAddCustom = document.getElementById("btnConfirmAddCustom") as HTMLButtonElement;
const btnCancelAddCustom = document.getElementById("btnCancelAddCustom") as HTMLButtonElement;

function displayDetections() {
  waveformSection.style.display = "flex";
  reviewSection.style.display = "block";
  paramsSection.style.display = "flex";
  exportBar.style.display = "flex";
  playheadLine.style.display = "block";

  if (currentMetadata) {
    totalTimeDisplay.innerText = formatTime(currentMetadata.duration);
    timelineScrubber.max = currentMetadata.duration.toString();
  }

  reviewSubtext.innerText = `Found ${currentFillers.length} active mute regions. Toggle, preview, or click timeline to edit.`;
  renderFillersList();
  renderWaveform();
  updateSummary();
  updatePlayhead(0);
}

function renderFillersList() {
  detectionList.innerHTML = "";

  currentFillers.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `detection-item ${item.enabled ? "" : "disabled"}`;

    const dur = Math.max(0.01, item.end - item.start);
    const confPct = Math.round(item.confidence * 100);
    const isCustom = item.id.startsWith("custom_");

    el.innerHTML = `
      <div class="detection-left">
        <label class="checkbox-container">
          <input type="checkbox" ${item.enabled ? "checked" : ""} data-id="${item.id}" />
          <span class="checkmark"></span>
        </label>
        <span class="filler-badge ${isCustom ? 'custom-badge' : ''}">${item.word}</span>
        <div class="detection-timestamps">
          <span>${formatTime(item.start)} → ${formatTime(item.end)}</span>
        </div>
        <span class="detection-duration">(${dur.toFixed(2)}s)</span>
      </div>
      <div class="detection-right">
        <span class="confidence-indicator">${isCustom ? 'Manual' : `${confPct}% conf`}</span>
        <button class="btn-preview" data-start="${item.start}" data-end="${item.end}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
        <button class="btn-delete-item" title="Remove this mute area" data-index="${index}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Toggle event
    const cb = el.querySelector("input[type='checkbox']") as HTMLInputElement;
    cb.addEventListener("change", () => {
      item.enabled = cb.checked;
      el.className = `detection-item ${item.enabled ? "" : "disabled"}`;
      updateSummary();
      renderWaveform();
    });

    // Preview event
    const prevBtn = el.querySelector(".btn-preview") as HTMLButtonElement;
    prevBtn.addEventListener("click", () => {
      previewRegion(item.start, item.end, prevBtn);
    });

    // Delete item event
    const delBtn = el.querySelector(".btn-delete-item") as HTMLButtonElement;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentFillers.splice(index, 1);
      renderFillersList();
      updateSummary();
      renderWaveform();
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

// Audio Preview: plays the exact region that will be muted
async function previewRegion(start: number, end: number, btn?: HTMLButtonElement) {
  if (!currentMetadata) return;

  pauseAudio();

  const paddingMs = parseFloat((document.getElementById("paramPaddingBefore") as HTMLInputElement)?.value) || 30;
  const padSec = paddingMs / 1000.0;

  const playStart = Math.max(0, start - padSec);
  const playEnd = Math.min(currentMetadata.duration, end + padSec);
  const playDuration = Math.max(0.05, playEnd - playStart);

  if (btn) {
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Playing...`;
    btn.style.background = "var(--accent-blue)";
    btn.style.borderColor = "var(--accent-blue)";
    btn.style.color = "#FFF";

    setTimeout(() => {
      btn.innerHTML = originalHtml;
      btn.style.background = "";
      btn.style.color = "";
    }, playDuration * 1000);
  }

  updatePlayhead(playStart);

  try {
    await invoke("play_audio_snippet", {
      path: currentMetadata.file_path,
      start: playStart,
      duration: playDuration
    });
  } catch (err: any) {
    console.error("Preview audio error:", err);
  }
}

// -------------------------------------------------------------
// Timeline Transport & Audio Scrubbing Logic
// -------------------------------------------------------------
async function playAudio(fromTime?: number) {
  if (!currentMetadata) return;

  const seekTime = fromTime !== undefined ? fromTime : currentTime;
  currentTime = seekTime;
  playbackStartOffset = seekTime;
  playbackStartTimestamp = performance.now();

  try {
    await invoke("play_audio_snippet", {
      path: currentMetadata.file_path,
      start: seekTime,
      duration: 0.0 // 0.0 means continuous playback until stopped
    });
    isPlaying = true;
    updateTransportUI();
    startPlayheadLoop();
  } catch (err) {
    console.error("Play audio failed:", err);
  }
}

async function pauseAudio() {
  if (!isPlaying) return;
  isPlaying = false;
  try {
    await invoke("stop_audio");
  } catch (err) {
    console.error("Stop audio failed:", err);
  }
  updateTransportUI();
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function stopAudio() {
  pauseAudio();
  seekTo(0);
}

function seekTo(timeInSeconds: number) {
  if (!currentMetadata) return;
  const clamped = Math.max(0, Math.min(currentMetadata.duration, timeInSeconds));
  currentTime = clamped;
  updatePlayhead(clamped);

  if (isPlaying) {
    playAudio(clamped);
  }
}

function updatePlayhead(timeInSeconds: number) {
  if (!currentMetadata) return;
  const duration = currentMetadata.duration || 1;
  const ratio = Math.max(0, Math.min(1, timeInSeconds / duration));
  const containerW = waveformContainer.clientWidth;
  const px = ratio * containerW;

  playheadLine.style.left = `${px}px`;
  timelineScrubber.value = timeInSeconds.toString();
  currentTimeDisplay.innerText = formatTime(timeInSeconds);
}

function startPlayheadLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }

  function loop() {
    if (!isPlaying || !currentMetadata) return;

    const elapsed = (performance.now() - playbackStartTimestamp) / 1000.0;
    const nowPos = playbackStartOffset + elapsed;

    if (nowPos >= currentMetadata.duration) {
      pauseAudio();
      seekTo(currentMetadata.duration);
      return;
    }

    currentTime = nowPos;
    updatePlayhead(nowPos);
    animationFrameId = requestAnimationFrame(loop);
  }

  animationFrameId = requestAnimationFrame(loop);
}

function updateTransportUI() {
  if (isPlaying) {
    transportPlayIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
    transportPlayText.innerText = "Pause";
    transportPlayBtn.style.background = "var(--accent-blue)";
    transportPlayBtn.style.borderColor = "var(--accent-blue)";
    transportPlayBtn.style.color = "#FFF";
  } else {
    transportPlayIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
    transportPlayText.innerText = "Play";
    transportPlayBtn.style.background = "";
    transportPlayBtn.style.color = "";
  }
}

// Transport Event Listeners
transportPlayBtn.addEventListener("click", () => {
  if (isPlaying) {
    pauseAudio();
  } else {
    playAudio();
  }
});

transportStopBtn.addEventListener("click", () => {
  stopAudio();
});

transportBackBtn.addEventListener("click", () => {
  seekTo(currentTime - 3.0);
});

transportFwdBtn.addEventListener("click", () => {
  seekTo(currentTime + 3.0);
});

timelineScrubber.addEventListener("input", () => {
  const target = parseFloat(timelineScrubber.value);
  seekTo(target);
});

// Spacebar shortcut
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) {
    e.preventDefault();
    if (isPlaying) {
      pauseAudio();
    } else {
      playAudio();
    }
  }
});

// -------------------------------------------------------------
// Interactive Waveform: Scrub, Click-to-Toggle, Drag-to-Create
// -------------------------------------------------------------
function getTimestampFromX(clientX: number): number {
  if (!currentMetadata) return 0;
  const rect = waveformContainer.getBoundingClientRect();
  const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const ratio = relX / rect.width;
  return ratio * currentMetadata.duration;
}

waveformContainer.addEventListener("mousemove", (e) => {
  if (!currentMetadata) return;
  const t = getTimestampFromX(e.clientX);
  const rect = waveformContainer.getBoundingClientRect();
  const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));

  timelineHoverTooltip.style.display = "block";
  timelineHoverTooltip.style.left = `${relX}px`;
  timelineHoverTooltip.innerText = formatTime(t);

  // If dragging a custom selection
  if (isSelectingWaveform) {
    selectionCurrentX = relX;
    const minX = Math.min(selectionStartX, selectionCurrentX);
    const maxX = Math.max(selectionStartX, selectionCurrentX);
    timelineSelection.style.display = "block";
    timelineSelection.style.left = `${minX}px`;
    timelineSelection.style.width = `${maxX - minX}px`;
  } else if (isDraggingTimeline) {
    seekTo(t);
  }
});

waveformContainer.addEventListener("mouseleave", () => {
  timelineHoverTooltip.style.display = "none";
  if (!isSelectingWaveform) {
    timelineSelection.style.display = "none";
  }
});

waveformContainer.addEventListener("mousedown", (e) => {
  if (!currentMetadata) return;
  const rect = waveformContainer.getBoundingClientRect();
  const relX = e.clientX - rect.left;
  const clickTime = (relX / rect.width) * currentMetadata.duration;

  // Check if click was directly inside an existing filler region
  const hitIndex = currentFillers.findIndex(f => clickTime >= f.start && clickTime <= f.end);

  if (e.button === 2 || e.shiftKey) {
    // Right click or shift-click on region removes it immediately
    if (hitIndex !== -1) {
      currentFillers.splice(hitIndex, 1);
      renderFillersList();
      updateSummary();
      renderWaveform();
      return;
    }
  }

  if (hitIndex !== -1) {
    // Clicking toggles enabled state of that region
    currentFillers[hitIndex].enabled = !currentFillers[hitIndex].enabled;
    renderFillersList();
    updateSummary();
    renderWaveform();
    return;
  }

  // If alt key or drag on empty space, initiate region selection
  if (e.altKey) {
    isSelectingWaveform = true;
    selectionStartX = relX;
    selectionCurrentX = relX;
  } else {
    // Scrub to clicked location
    isDraggingTimeline = true;
    seekTo(clickTime);
  }
});

window.addEventListener("mouseup", () => {
  if (isDraggingTimeline) {
    isDraggingTimeline = false;
  }

  if (isSelectingWaveform) {
    isSelectingWaveform = false;
    timelineSelection.style.display = "none";

    const rect = waveformContainer.getBoundingClientRect();
    const minX = Math.min(selectionStartX, selectionCurrentX);
    const maxX = Math.max(selectionStartX, selectionCurrentX);

    if (currentMetadata && (maxX - minX) > 4) {
      const startTime = (minX / rect.width) * currentMetadata.duration;
      const endTime = (maxX / rect.width) * currentMetadata.duration;

      // Prompt or fill in manual add form
      manualAddPanel.style.display = "block";
      manualStartInput.value = startTime.toFixed(3);
      manualEndInput.value = endTime.toFixed(3);
      manualWordInput.focus();
    }
  }
});

// Prevent context menu on right click to allow quick deletion
waveformContainer.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// Double click on a band to remove it
waveformContainer.addEventListener("dblclick", (e) => {
  if (!currentMetadata) return;
  const clickTime = getTimestampFromX(e.clientX);
  const hitIndex = currentFillers.findIndex(f => clickTime >= f.start && clickTime <= f.end);
  if (hitIndex !== -1) {
    currentFillers.splice(hitIndex, 1);
    renderFillersList();
    updateSummary();
    renderWaveform();
  }
});

// -------------------------------------------------------------
// Manual Addition Controls
// -------------------------------------------------------------
openAddCustomModalBtn.addEventListener("click", () => {
  if (manualAddPanel.style.display === "none") {
    manualAddPanel.style.display = "block";
    manualStartInput.value = currentTime.toFixed(3);
    manualEndInput.value = Math.min(currentMetadata ? currentMetadata.duration : 10, currentTime + 0.6).toFixed(3);
    manualWordInput.focus();
  } else {
    manualAddPanel.style.display = "none";
  }
});

btnSetStartCurrent.addEventListener("click", () => {
  manualStartInput.value = currentTime.toFixed(3);
});

btnSetEndCurrent.addEventListener("click", () => {
  manualEndInput.value = currentTime.toFixed(3);
});

btnCancelAddCustom.addEventListener("click", () => {
  manualAddPanel.style.display = "none";
});

btnConfirmAddCustom.addEventListener("click", () => {
  const word = manualWordInput.value.trim() || "custom";
  const start = parseFloat(manualStartInput.value);
  const end = parseFloat(manualEndInput.value);

  if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
    alert("Please enter valid start and end timestamps (end must be greater than start).");
    return;
  }

  const newItem: FillerItem = {
    id: `custom_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    word,
    start,
    end,
    confidence: 1.0,
    enabled: true,
  };

  currentFillers.push(newItem);
  currentFillers.sort((a, b) => a.start - b.start);

  renderFillersList();
  updateSummary();
  renderWaveform();
  manualAddPanel.style.display = "none";
});

// Waveform rendering
function renderWaveform() {
  const ctx = waveformCanvas.getContext("2d");
  if (!ctx || !currentMetadata) return;

  const width = (waveformCanvas.width = waveformCanvas.offsetWidth);
  const height = (waveformCanvas.height = waveformCanvas.offsetHeight);
  const duration = currentMetadata.duration;

  ctx.clearRect(0, 0, width, height);

  // Draw simulated soundwave bars
  const barCount = 200;
  const barWidth = width / barCount;
  ctx.fillStyle = "#334155";

  for (let i = 0; i < barCount; i++) {
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
    const isCustom = f.id.startsWith("custom_");

    if (f.enabled) {
      // Red muted zone (custom ones highlighted purple-red)
      ctx.fillStyle = isCustom ? "rgba(168, 85, 247, 0.45)" : "rgba(244, 63, 94, 0.45)";
      ctx.fillRect(startX, 0, zoneW, height);

      ctx.strokeStyle = isCustom ? "#A855F7" : "#F43F5E";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(startX, 0, zoneW, height);

      // Label badge
      ctx.fillStyle = "#FFF";
      ctx.font = "bold 10px JetBrains Mono, monospace";
      ctx.fillText(f.word.toUpperCase(), startX + 3, 14);
    } else {
      // Disabled (dim gray)
      ctx.fillStyle = "rgba(100, 116, 139, 0.2)";
      ctx.fillRect(startX, 0, zoneW, height);
      ctx.strokeStyle = "rgba(100, 116, 139, 0.4)";
      ctx.strokeRect(startX, 0, zoneW, height);
    }
  });
}

// Export cleaned file
exportBtn.addEventListener("click", async () => {
  if (!currentMetadata) return;

  try {
    pauseAudio();

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
;
