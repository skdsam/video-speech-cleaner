import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

interface MediaMetadata {
  file_name: string;
  file_path: string;
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
  peaks: number[];
}

interface ProgressPayload {
  percent: number;
  stage: string;
}

let currentMetadata: MediaMetadata | null = null;
let currentFillers: FillerItem[] = [];
let audioPeaks: number[] = [];

// DOM Elements: Import & Metadata
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
const engineStatusLabel = document.getElementById("engineStatusLabel") as HTMLElement;

// Progress
const progressSection = document.getElementById("progressSection") as HTMLElement;
const progressStatus = document.getElementById("progressStatus") as HTMLElement;
const progressPercent = document.getElementById("progressPercent") as HTMLElement;
const progressBar = document.getElementById("progressBar") as HTMLElement;
const cancelAnalysisBtn = document.getElementById("cancelAnalysisBtn") as HTMLButtonElement;

// Middle Workspace (Video & Regions)
const workspaceRow = document.getElementById("workspaceRow") as HTMLElement;
const videoMonitorContainer = document.getElementById("videoMonitorContainer") as HTMLElement;
const videoPreviewPlayer = document.getElementById("videoPreviewPlayer") as HTMLVideoElement;
const videoPlaceholder = document.getElementById("videoPlaceholder") as HTMLElement;
const toggleVideoSizeBtn = document.getElementById("toggleVideoSizeBtn") as HTMLButtonElement;
const toggleVideoVisibilityBtn = document.getElementById("toggleVideoVisibilityBtn") as HTMLButtonElement;
const showVideoBtn = document.getElementById("showVideoBtn") as HTMLButtonElement;
let isVideoVisible = false; // Hidden by default as requested

const reviewSection = document.getElementById("reviewSection") as HTMLElement;
const regionsCountBadge = document.getElementById("regionsCountBadge") as HTMLElement;
const detectionList = document.getElementById("detectionList") as HTMLElement;
const selectAllBtn = document.getElementById("selectAllBtn") as HTMLButtonElement;
const deselectAllBtn = document.getElementById("deselectAllBtn") as HTMLButtonElement;
const selectConfidentBtn = document.getElementById("selectConfidentBtn") as HTMLButtonElement;

// Bottom Workstation Station
const waveformSection = document.getElementById("waveformSection") as HTMLElement;
const waveformViewport = document.getElementById("waveformViewport") as HTMLElement;
const waveformContainer = document.getElementById("waveformContainer") as HTMLElement;
const waveformCanvas = document.getElementById("waveformCanvas") as HTMLCanvasElement;
const minimapContainer = document.getElementById("minimapContainer") as HTMLElement;
const minimapCanvas = document.getElementById("minimapCanvas") as HTMLCanvasElement;
const minimapViewport = document.getElementById("minimapViewport") as HTMLElement;
const rulerCanvas = document.getElementById("rulerCanvas") as HTMLCanvasElement;

const playheadLine = document.getElementById("playheadLine") as HTMLElement;
const timelineSelection = document.getElementById("timelineSelection") as HTMLElement;
const timelineHoverTooltip = document.getElementById("timelineHoverTooltip") as HTMLElement;

const currentTimeDisplay = document.getElementById("currentTimeDisplay") as HTMLElement;
const totalTimeDisplay = document.getElementById("totalTimeDisplay") as HTMLElement;
const timelineScrubber = document.getElementById("timelineScrubber") as HTMLInputElement;

// Zoom Controls
const zoomSlider = document.getElementById("zoomSlider") as HTMLInputElement;
const zoomInBtn = document.getElementById("zoomInBtn") as HTMLButtonElement;
const zoomOutBtn = document.getElementById("zoomOutBtn") as HTMLButtonElement;
const zoomFitBtn = document.getElementById("zoomFitBtn") as HTMLButtonElement;
const zoomLevelDisplay = document.getElementById("zoomLevelDisplay") as HTMLElement;

// Transport Controls
const transportPlayBtn = document.getElementById("transportPlayBtn") as HTMLButtonElement;
const transportPlayIcon = document.getElementById("transportPlayIcon") as unknown as SVGElement;
const transportPlayText = document.getElementById("transportPlayText") as HTMLElement;
const transportStopBtn = document.getElementById("transportStopBtn") as HTMLButtonElement;
const transportBackBtn = document.getElementById("transportBackBtn") as HTMLButtonElement;
const transportFwdBtn = document.getElementById("transportFwdBtn") as HTMLButtonElement;

// Manual Add Panel
const openAddCustomModalBtn = document.getElementById("openAddCustomModalBtn") as HTMLButtonElement;
const manualAddPanel = document.getElementById("manualAddPanel") as HTMLElement;
const manualWordInput = document.getElementById("manualWordInput") as HTMLInputElement;
const manualStartInput = document.getElementById("manualStartInput") as HTMLInputElement;
const manualEndInput = document.getElementById("manualEndInput") as HTMLInputElement;
const btnSetStartCurrent = document.getElementById("btnSetStartCurrent") as HTMLButtonElement;
const btnSetEndCurrent = document.getElementById("btnSetEndCurrent") as HTMLButtonElement;
const btnConfirmAddCustom = document.getElementById("btnConfirmAddCustom") as HTMLButtonElement;
const btnCancelAddCustom = document.getElementById("btnCancelAddCustom") as HTMLButtonElement;

// Parameters & Export Bar
const paramsSection = document.getElementById("paramsSection") as HTMLElement;
const exportBar = document.getElementById("exportBar") as HTMLElement;
const summaryMuteCount = document.getElementById("summaryMuteCount") as HTMLElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;

// -------------------------------------------------------------
// Multi-Scale Zoom & Viewport State
// -------------------------------------------------------------
let zoomLevel = 1.0; // 1.0 = fit to viewport; up to 50.0x for deep zoom
let isPlaying = false;
let currentTime = 0;
let playbackStartTimestamp = 0;
let playbackStartOffset = 0;
let animationFrameId: number | null = null;
let isDraggingTimeline = false;
let isSelectingWaveform = false;
let isDraggingMinimap = false;
let selectionStartX = 0;
let selectionCurrentX = 0;

// -------------------------------------------------------------
// File Pick & Loading
// -------------------------------------------------------------
selectFileBtn.addEventListener("click", async () => {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Video and Audio",
          extensions: ["mp4", "mov", "mkv", "webm", "avi", "wav", "mp3", "m4a", "flac"],
        },
      ],
    });

    if (selected && typeof selected === "string") {
      loadMediaFile(selected);
    }
  } catch (err) {
    console.error("Open file error:", err);
    fallbackPromptFile();
  }
});

changeFileBtn.addEventListener("click", () => {
  selectFileBtn.click();
});

function fallbackPromptFile() {
  const path = prompt(
    "Enter full video file path to test (e.g. D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4):",
    "D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4"
  );
  if (path) {
    loadMediaFile(path);
  }
}

// Drag & drop support
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

async function loadMediaFile(filePath: string) {
  try {
    dropSection.style.display = "none";
    mediaCard.style.display = "flex";

    const meta = await invoke<MediaMetadata>("inspect_media", { path: filePath });
    currentMetadata = meta;

    metaFileName.innerText = meta.file_name;
    chipDuration.innerText = `Duration: ${formatTimecode(meta.duration)}`;
    chipResolution.innerText = meta.width && meta.height ? `${meta.width}x${meta.height}` : "Audio Only";
    chipVideoCodec.innerText = meta.video_codec ? `Video: ${meta.video_codec}` : "No Video Stream";
    chipAudioCodec.innerText = meta.audio_codec ? `Audio: ${meta.audio_codec}` : "Unknown Audio";
    chipSampleRate.innerText = meta.sample_rate ? `${(meta.sample_rate / 1000).toFixed(1)} kHz` : "";

    // Synchronize video player source via Tauri asset protocol
    if (meta.video_codec) {
      // In Tauri 2 with asset protocol enabled, convertFileSrc converts absolute Windows paths to asset:// URLs
      videoPreviewPlayer.src = convertFileSrc(filePath);
      videoPreviewPlayer.muted = true;
      videoPreviewPlayer.volume = 0;
      videoPreviewPlayer.style.display = "block";
      videoPlaceholder.style.display = "none";
      videoPreviewPlayer.load();
    } else {
      videoPreviewPlayer.src = "";
      videoPreviewPlayer.style.display = "none";
      videoPlaceholder.style.display = "block";
    }

    // Default to hidden video viewport as requested
    isVideoVisible = false;
    applyVideoVisibility();

    // Reset workspace view until analysis
    workspaceRow.style.display = "none";
    waveformSection.style.display = "none";
    paramsSection.style.display = "none";
    exportBar.style.display = "none";
    engineStatusLabel.innerText = "File Loaded";
  } catch (e: any) {
    alert("Error inspecting file: " + (e.message || e));
    dropSection.style.display = "flex";
    mediaCard.style.display = "none";
  }
}

function applyVideoVisibility() {
  const hasVideo = !!(currentMetadata && currentMetadata.video_codec);
  if (!hasVideo) {
    videoMonitorContainer.style.display = "none";
    workspaceRow.classList.add("video-hidden");
    showVideoBtn.style.display = "none";
    return;
  }

  if (isVideoVisible) {
    videoMonitorContainer.style.display = "flex";
    workspaceRow.classList.remove("video-hidden");
    showVideoBtn.style.display = "none";
    // Sync current playhead time when made visible
    if (videoPreviewPlayer.src && !isNaN(videoPreviewPlayer.duration)) {
      videoPreviewPlayer.currentTime = currentTime;
      if (isPlaying) {
        videoPreviewPlayer.play().catch(() => {});
      }
    }
  } else {
    videoMonitorContainer.style.display = "none";
    workspaceRow.classList.add("video-hidden");
    showVideoBtn.style.display = "inline-flex";
    // Pause video to free resources and ensure zero audio leaks
    videoPreviewPlayer.pause();
  }
  renderAllViews();
}

toggleVideoVisibilityBtn.addEventListener("click", () => {
  isVideoVisible = false;
  applyVideoVisibility();
});

showVideoBtn.addEventListener("click", () => {
  isVideoVisible = true;
  applyVideoVisibility();
});

// Video Size Expansion Toggle
toggleVideoSizeBtn.addEventListener("click", () => {
  workspaceRow.classList.toggle("video-expanded");
  const isExp = workspaceRow.classList.contains("video-expanded");
  toggleVideoSizeBtn.innerText = isExp ? "Compact View" : "Expand View";
  renderAllViews();
});

// -------------------------------------------------------------
// Live Analysis Event Listener
// -------------------------------------------------------------
listen<ProgressPayload>("analysis-progress", (event) => {
  const { percent, stage } = event.payload;
  progressPercent.innerText = `${Math.round(percent)}%`;
  progressBar.style.width = `${percent}%`;
  progressStatus.innerText = stage;
});

cancelAnalysisBtn.addEventListener("click", async () => {
  try {
    cancelAnalysisBtn.disabled = true;
    cancelAnalysisBtn.innerText = "Cancelling...";
    await invoke("cancel_analysis");
  } catch (err) {
    console.error("Cancel analysis failed:", err);
  }
});

// -------------------------------------------------------------
// Speech Filler Analysis
// -------------------------------------------------------------
analyzeBtn.addEventListener("click", async () => {
  if (!currentMetadata) return;

  try {
    analyzeBtn.disabled = true;
    cancelAnalysisBtn.disabled = false;
    cancelAnalysisBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
      Cancel
    `;
    progressSection.style.display = "flex";
    progressStatus.innerText = "Initializing speech model & audio stream...";
    progressPercent.innerText = "2%";
    progressBar.style.width = "2%";
    engineStatusLabel.innerText = "Whisper Analysing...";

    const result = await invoke<AnalysisResult>("analyze_audio", { path: currentMetadata.file_path });
    currentFillers = result.fillers;
    audioPeaks = result.peaks && result.peaks.length > 0 ? result.peaks : [];

    progressPercent.innerText = "100%";
    progressBar.style.width = "100%";
    progressStatus.innerText = `Detected ${currentFillers.length} filler words! Loading workstation...`;
    engineStatusLabel.innerText = "Analysis Complete";

    setTimeout(() => {
      progressSection.style.display = "none";
      displayWorkstation();
    }, 400);
  } catch (err: any) {
    const msg = String(err.message || err);
    if (!msg.includes("cancelled")) {
      alert("Analysis failed: " + msg);
    }
    progressSection.style.display = "none";
    engineStatusLabel.innerText = msg.includes("cancelled") ? "Analysis Cancelled" : "Analysis Failed";
  } finally {
    analyzeBtn.disabled = false;
  }
});

function displayWorkstation() {
  workspaceRow.style.display = "grid";
  reviewSection.style.display = "flex";
  waveformSection.style.display = "flex";
  paramsSection.style.display = "flex";
  exportBar.style.display = "flex";
  playheadLine.style.display = "block";

  // Enforce hidden by default video dock
  applyVideoVisibility();

  if (currentMetadata) {
    totalTimeDisplay.innerText = formatTimecode(currentMetadata.duration);
    timelineScrubber.max = currentMetadata.duration.toString();
  }

  zoomLevel = 1.0;
  zoomSlider.value = "1";
  zoomLevelDisplay.innerText = "1.0x";

  renderFillersList();
  renderAllViews();
  updateSummary();
  updatePlayhead(0);
}

// -------------------------------------------------------------
// Synchronized Video & Audio Transport Logic
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
      duration: 0.0, // 0.0 = continuous playback
    });

    if (isVideoVisible && videoPreviewPlayer.src && !isNaN(videoPreviewPlayer.duration)) {
      videoPreviewPlayer.currentTime = seekTime;
      videoPreviewPlayer.play().catch(() => {});
    }

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

  if (videoPreviewPlayer.src) {
    videoPreviewPlayer.pause();
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

  // Keep video synchronized frame-by-frame if visible
  if (isVideoVisible && videoPreviewPlayer.src && !isNaN(videoPreviewPlayer.duration)) {
    videoPreviewPlayer.currentTime = clamped;
  }

  updatePlayhead(clamped);

  if (isPlaying) {
    playAudio(clamped);
  }
}

function updatePlayhead(timeInSeconds: number) {
  if (!currentMetadata) return;
  const duration = currentMetadata.duration || 1;
  const ratio = Math.max(0, Math.min(1, timeInSeconds / duration));

  // Position on main zoomed waveform
  const totalTrackW = waveformCanvas.width || waveformViewport.clientWidth;
  const px = ratio * totalTrackW;
  playheadLine.style.left = `${px}px`;

  // Auto-scroll waveform viewport during playback if zoomed in
  if (isPlaying && zoomLevel > 1.0) {
    const viewW = waveformViewport.clientWidth;
    const scrollLeft = waveformViewport.scrollLeft;
    if (px > scrollLeft + viewW * 0.8 || px < scrollLeft) {
      waveformViewport.scrollLeft = Math.max(0, px - viewW * 0.2);
    }
  }

  // Update minimap indicator
  updateMinimapViewport();

  timelineScrubber.value = timeInSeconds.toString();
  currentTimeDisplay.innerText = formatTimecode(timeInSeconds);
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
  if (isPlaying) pauseAudio();
  else playAudio();
});

transportStopBtn.addEventListener("click", () => stopAudio());
transportBackBtn.addEventListener("click", () => seekTo(currentTime - 3.0));
transportFwdBtn.addEventListener("click", () => seekTo(currentTime + 3.0));

timelineScrubber.addEventListener("input", () => {
  const target = parseFloat(timelineScrubber.value);
  seekTo(target);
});

// Spacebar Play/Pause Shortcut
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && (e.target === document.body || e.target === waveformViewport)) {
    e.preventDefault();
    if (isPlaying) pauseAudio();
    else playAudio();
  }
});

// -------------------------------------------------------------
// High-Precision Waveform Zoom & Navigation Engine
// -------------------------------------------------------------
function setZoom(newZoom: number, anchorRatio: number = 0.5) {
  if (!currentMetadata) return;
  const clamped = Math.max(1.0, Math.min(50.0, newZoom));
  const oldZoom = zoomLevel;
  zoomLevel = clamped;

  zoomSlider.value = zoomLevel.toString();
  zoomLevelDisplay.innerText = `${zoomLevel.toFixed(1)}x`;

  // Preserve scroll anchor location under mouse cursor
  const viewportW = waveformViewport.clientWidth;
  const oldScrollLeft = waveformViewport.scrollLeft;
  const anchorX = oldScrollLeft + viewportW * anchorRatio;
  const anchorTimeRatio = anchorX / (viewportW * oldZoom);

  renderWaveformTrack();
  renderRuler();
  updateMinimapViewport();

  const newTotalW = viewportW * zoomLevel;
  waveformViewport.scrollLeft = Math.max(0, anchorTimeRatio * newTotalW - viewportW * anchorRatio);
}

zoomSlider.addEventListener("input", () => {
  setZoom(parseFloat(zoomSlider.value));
});

zoomInBtn.addEventListener("click", () => {
  setZoom(zoomLevel * 1.35);
});

zoomOutBtn.addEventListener("click", () => {
  setZoom(zoomLevel / 1.35);
});

zoomFitBtn.addEventListener("click", () => {
  setZoom(1.0);
  waveformViewport.scrollLeft = 0;
});

// Ctrl + MouseWheel to zoom; Shift + MouseWheel to horizontal pan
waveformViewport.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = waveformViewport.getBoundingClientRect();
      const mouseRatio = (e.clientX - rect.left) / rect.width;
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      setZoom(zoomLevel * zoomFactor, mouseRatio);
    } else if (e.shiftKey) {
      e.preventDefault();
      waveformViewport.scrollLeft += e.deltaY;
    }
  },
  { passive: false }
);

waveformViewport.addEventListener("scroll", () => {
  updateMinimapViewport();
  renderRuler();
});

// -------------------------------------------------------------
// Waveform Rendering (Adaptive True Peaks + Mute Regions)
// -------------------------------------------------------------
function renderAllViews() {
  renderWaveformTrack();
  renderMinimap();
  renderRuler();
}

function renderWaveformTrack() {
  if (!currentMetadata) return;

  const viewportW = waveformViewport.clientWidth || 800;
  const totalTrackW = Math.round(viewportW * zoomLevel);
  const trackHeight = waveformCanvas.offsetHeight || 110;

  waveformCanvas.width = totalTrackW;
  waveformCanvas.height = trackHeight;
  waveformContainer.style.width = `${totalTrackW}px`;

  const ctx = waveformCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, totalTrackW, trackHeight);

  // 1. Draw True Waveform Peak Geometry
  const peakCount = audioPeaks.length > 0 ? audioPeaks.length : 200;
  const barWidth = Math.max(1, totalTrackW / (peakCount * (zoomLevel > 1 ? zoomLevel * 0.4 : 1)));
  const barStep = barWidth + 1;
  const totalBars = Math.floor(totalTrackW / barStep);

  ctx.fillStyle = "#334155";

  for (let i = 0; i < totalBars; i++) {
    const progress = i / totalBars;
    let amp = 0.25;

    if (audioPeaks.length > 0) {
      const peakIndex = Math.min(audioPeaks.length - 1, Math.floor(progress * audioPeaks.length));
      amp = audioPeaks[peakIndex];
    } else {
      amp = Math.sin(progress * Math.PI * 4) * 0.3 + 0.5;
    }

    const barH = Math.max(3, amp * (trackHeight * 0.8));
    const y = (trackHeight - barH) / 2;
    ctx.fillRect(i * barStep, y, barWidth, barH);
  }

  // 2. Draw Active Mute Zones
  const duration = currentMetadata.duration;

  currentFillers.forEach((f) => {
    const startX = (f.start / duration) * totalTrackW;
    const endX = (f.end / duration) * totalTrackW;
    const zoneW = Math.max(endX - startX, 4);
    const isCustom = f.id.startsWith("custom_");

    if (f.enabled) {
      // Red muted zone (custom ones highlighted violet)
      ctx.fillStyle = isCustom ? "rgba(139, 92, 246, 0.38)" : "rgba(225, 29, 72, 0.38)";
      ctx.fillRect(startX, 0, zoneW, trackHeight);

      ctx.strokeStyle = isCustom ? "#8B5CF6" : "#E11D48";
      ctx.lineWidth = 1;
      ctx.strokeRect(startX, 0, zoneW, trackHeight);

      // Label badge
      ctx.fillStyle = "#FFF";
      ctx.font = "bold 10px JetBrains Mono, monospace";
      ctx.fillText(f.word.toUpperCase(), startX + 3, 13);
    } else {
      // Disabled (gray)
      ctx.fillStyle = "rgba(100, 116, 139, 0.2)";
      ctx.fillRect(startX, 0, zoneW, trackHeight);
      ctx.strokeStyle = "rgba(100, 116, 139, 0.4)";
      ctx.strokeRect(startX, 0, zoneW, trackHeight);
    }
  });

  updatePlayhead(currentTime);
}

// -------------------------------------------------------------
// Minimap Overview Bar
// -------------------------------------------------------------
function renderMinimap() {
  if (!currentMetadata) return;

  const width = (minimapCanvas.width = minimapCanvas.offsetWidth);
  const height = (minimapCanvas.height = minimapCanvas.offsetHeight);
  const ctx = minimapCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  // Draw miniature peak silhouette
  ctx.fillStyle = "#2D3748";
  const bars = Math.min(width, 240);
  const barW = width / bars;

  for (let i = 0; i < bars; i++) {
    const progress = i / bars;
    let amp = 0.3;
    if (audioPeaks.length > 0) {
      const idx = Math.min(audioPeaks.length - 1, Math.floor(progress * audioPeaks.length));
      amp = audioPeaks[idx];
    }
    const h = Math.max(2, amp * (height * 0.85));
    const y = (height - h) / 2;
    ctx.fillRect(i * barW, y, barW - 0.5, h);
  }

  // Draw mute regions on minimap
  const duration = currentMetadata.duration;
  currentFillers.forEach((f) => {
    if (!f.enabled) return;
    const startX = (f.start / duration) * width;
    const endX = (f.end / duration) * width;
    ctx.fillStyle = f.id.startsWith("custom_") ? "rgba(139, 92, 246, 0.8)" : "rgba(225, 29, 72, 0.8)";
    ctx.fillRect(startX, 0, Math.max(endX - startX, 2), height);
  });

  updateMinimapViewport();
}

function updateMinimapViewport() {
  if (!currentMetadata) return;
  const viewportW = waveformViewport.clientWidth;
  const totalTrackW = waveformCanvas.width || viewportW;
  const scrollLeft = waveformViewport.scrollLeft;

  const leftRatio = scrollLeft / totalTrackW;
  const widthRatio = Math.min(1.0, viewportW / totalTrackW);

  minimapViewport.style.left = `${leftRatio * 100}%`;
  minimapViewport.style.width = `${widthRatio * 100}%`;
}

// Minimap Drag/Click to Scroll
minimapContainer.addEventListener("mousedown", (e) => {
  if (!currentMetadata) return;
  isDraggingMinimap = true;
  handleMinimapClick(e);
});

window.addEventListener("mousemove", (e) => {
  if (isDraggingMinimap && currentMetadata) {
    handleMinimapClick(e);
  }
});

window.addEventListener("mouseup", () => {
  isDraggingMinimap = false;
});

function handleMinimapClick(e: MouseEvent) {
  const rect = minimapContainer.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const totalTrackW = waveformCanvas.width;
  const viewportW = waveformViewport.clientWidth;

  waveformViewport.scrollLeft = ratio * totalTrackW - viewportW / 2;
  seekTo(ratio * (currentMetadata?.duration || 0));
}

// -------------------------------------------------------------
// Adaptive Timecode Ruler
// -------------------------------------------------------------
function renderRuler() {
  if (!currentMetadata) return;

  const width = (rulerCanvas.width = rulerCanvas.offsetWidth);
  const height = (rulerCanvas.height = rulerCanvas.offsetHeight);
  const ctx = rulerCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  const duration = currentMetadata.duration;
  const viewportW = waveformViewport.clientWidth;
  const totalTrackW = waveformCanvas.width || viewportW;
  const scrollLeft = waveformViewport.scrollLeft;

  const visibleStartSec = (scrollLeft / totalTrackW) * duration;
  const visibleEndSec = ((scrollLeft + viewportW) / totalTrackW) * duration;
  const visibleDuration = visibleEndSec - visibleStartSec;

  // Determine adaptive step intervals
  let stepSec = 1.0;
  if (visibleDuration > 600) stepSec = 60.0;
  else if (visibleDuration > 120) stepSec = 30.0;
  else if (visibleDuration > 45) stepSec = 10.0;
  else if (visibleDuration > 15) stepSec = 5.0;
  else if (visibleDuration > 5) stepSec = 1.0;
  else if (visibleDuration > 1) stepSec = 0.5;
  else stepSec = 0.1;

  ctx.fillStyle = "#64748B";
  ctx.strokeStyle = "#29303E";
  ctx.font = "9px JetBrains Mono, monospace";

  const firstTick = Math.floor(visibleStartSec / stepSec) * stepSec;

  for (let t = firstTick; t <= visibleEndSec + stepSec; t += stepSec) {
    const x = ((t / duration) * totalTrackW) - scrollLeft;
    if (x < 0 || x > width) continue;

    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x, height - 7);
    ctx.stroke();

    const label = formatTimecodeRuler(t, stepSec < 1.0);
    ctx.fillText(label, x + 3, height - 8);
  }
}

// -------------------------------------------------------------
// Interactive Waveform Scrubbing, Toggling & Custom Dragging
// -------------------------------------------------------------
function getTimestampFromClientX(clientX: number): number {
  if (!currentMetadata) return 0;
  const rect = waveformContainer.getBoundingClientRect();
  const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const ratio = relX / rect.width;
  return ratio * currentMetadata.duration;
}

waveformContainer.addEventListener("mousemove", (e) => {
  if (!currentMetadata) return;
  const t = getTimestampFromClientX(e.clientX);
  const rect = waveformContainer.getBoundingClientRect();
  const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));

  timelineHoverTooltip.style.display = "block";
  timelineHoverTooltip.style.left = `${relX}px`;
  timelineHoverTooltip.innerText = formatTimecode(t);

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
  const clickTime = getTimestampFromClientX(e.clientX);
  const rect = waveformContainer.getBoundingClientRect();
  const relX = e.clientX - rect.left;

  // Check if clicked inside an existing filler region
  const hitIndex = currentFillers.findIndex((f) => clickTime >= f.start && clickTime <= f.end);

  if (e.button === 2 || e.shiftKey) {
    if (hitIndex !== -1) {
      currentFillers.splice(hitIndex, 1);
      renderFillersList();
      updateSummary();
      renderAllViews();
      return;
    }
  }

  if (hitIndex !== -1) {
    currentFillers[hitIndex].enabled = !currentFillers[hitIndex].enabled;
    renderFillersList();
    updateSummary();
    renderAllViews();
    return;
  }

  if (e.altKey) {
    isSelectingWaveform = true;
    selectionStartX = relX;
    selectionCurrentX = relX;
  } else {
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

    const totalTrackW = waveformCanvas.width;
    const minX = Math.min(selectionStartX, selectionCurrentX);
    const maxX = Math.max(selectionStartX, selectionCurrentX);

    if (currentMetadata && maxX - minX > 5) {
      const startTime = (minX / totalTrackW) * currentMetadata.duration;
      const endTime = (maxX / totalTrackW) * currentMetadata.duration;

      manualAddPanel.style.display = "block";
      manualStartInput.value = startTime.toFixed(3);
      manualEndInput.value = endTime.toFixed(3);
      manualWordInput.focus();
    }
  }
});

waveformContainer.addEventListener("contextmenu", (e) => e.preventDefault());

// Double click to remove region
waveformContainer.addEventListener("dblclick", (e) => {
  if (!currentMetadata) return;
  const clickTime = getTimestampFromClientX(e.clientX);
  const hitIndex = currentFillers.findIndex((f) => clickTime >= f.start && clickTime <= f.end);
  if (hitIndex !== -1) {
    currentFillers.splice(hitIndex, 1);
    renderFillersList();
    updateSummary();
    renderAllViews();
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
  renderAllViews();
  manualAddPanel.style.display = "none";
});

// -------------------------------------------------------------
// Detection List View & Bulk Actions
// -------------------------------------------------------------
function renderFillersList() {
  detectionList.innerHTML = "";
  regionsCountBadge.innerText = currentFillers.length.toString();

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
        <span class="filler-badge ${isCustom ? "custom-badge" : ""}">${item.word}</span>
        <div class="detection-timestamps">
          <span>${formatTimecode(item.start)} → ${formatTimecode(item.end)}</span>
        </div>
        <span class="detection-duration">(${dur.toFixed(2)}s)</span>
      </div>
      <div class="detection-right">
        <span class="confidence-indicator">${isCustom ? "Manual" : `${confPct}%`}</span>
        <button class="btn-preview" data-start="${item.start}" data-end="${item.end}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
        <button class="btn-delete-item" title="Remove mute area">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    const cb = el.querySelector("input[type='checkbox']") as HTMLInputElement;
    cb.addEventListener("change", () => {
      item.enabled = cb.checked;
      el.className = `detection-item ${item.enabled ? "" : "disabled"}`;
      updateSummary();
      renderAllViews();
    });

    const prevBtn = el.querySelector(".btn-preview") as HTMLButtonElement;
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      previewRegion(item.start, item.end, prevBtn);
    });

    const delBtn = el.querySelector(".btn-delete-item") as HTMLButtonElement;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentFillers.splice(index, 1);
      renderFillersList();
      updateSummary();
      renderAllViews();
    });

    // Clicking anywhere on the item row navigates the timeline playhead & video straight to the exact detected region
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).closest("button")) {
        return;
      }
      seekTo(item.start);
      // Ensure the region is scrolled into view if zoomed in
      if (zoomLevel > 1.0 && currentMetadata) {
        const totalTrackW = waveformCanvas.width || waveformViewport.clientWidth;
        const targetPx = (item.start / currentMetadata.duration) * totalTrackW;
        waveformViewport.scrollLeft = Math.max(0, targetPx - waveformViewport.clientWidth / 2);
      }
    });

    detectionList.appendChild(el);
  });
}

function updateSummary() {
  const activeCount = currentFillers.filter((f) => f.enabled).length;
  summaryMuteCount.innerText = activeCount.toString();
}

selectAllBtn.addEventListener("click", () => {
  currentFillers.forEach((f) => (f.enabled = true));
  renderFillersList();
  updateSummary();
  renderAllViews();
});

deselectAllBtn.addEventListener("click", () => {
  currentFillers.forEach((f) => (f.enabled = false));
  renderFillersList();
  updateSummary();
  renderAllViews();
});

selectConfidentBtn.addEventListener("click", () => {
  currentFillers.forEach((f) => {
    f.enabled = f.confidence >= 0.75;
  });
  renderFillersList();
  updateSummary();
  renderAllViews();
});

// -------------------------------------------------------------
// Audio Preview of Exact Muted Region
// -------------------------------------------------------------
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
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Playing`;
    btn.style.background = "var(--accent-blue)";
    btn.style.color = "#FFF";

    setTimeout(() => {
      btn.innerHTML = originalHtml;
      btn.style.background = "";
      btn.style.color = "";
    }, playDuration * 1000);
  }

  seekTo(playStart);

  try {
    await invoke("play_audio_snippet", {
      path: currentMetadata.file_path,
      start: playStart,
      duration: playDuration,
    });
  } catch (err) {
    console.error("Preview audio error:", err);
  }
}

// -------------------------------------------------------------
// Export Final Cleaned Video / Audio
// -------------------------------------------------------------
exportBtn.addEventListener("click", async () => {
  if (!currentMetadata) return;

  try {
    pauseAudio();

    const ext = currentMetadata.file_name.split(".").pop() || "mp4";
    const defaultOutput = currentMetadata.file_path.replace(`.${ext}`, `_cleaned.${ext}`);

    let savePath: string | null = null;
    try {
      savePath = await save({
        defaultPath: defaultOutput,
        filters: [
          {
            name: "Video / Audio",
            extensions: [ext],
          },
        ],
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
        fade_ms: fadeMs,
      },
    });

    alert(res);
  } catch (err: any) {
    alert("Export failed: " + (err.message || err));
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerText = "Export Cleaned Video";
  }
});

// -------------------------------------------------------------
// Timecode Formatting Utilities (HH:MM:SS.ms)
// -------------------------------------------------------------
function formatTimecode(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(2);

  const hStr = hrs > 0 ? `${hrs.toString().padStart(2, "0")}:` : "";
  const mStr = `${mins.toString().padStart(2, "0")}:`;
  const sStr = parseFloat(secs) < 10 ? `0${secs}` : `${secs}`;

  return `${hStr}${mStr}${sStr}`;
}

function formatTimecodeRuler(seconds: number, showDecimals: boolean): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const hStr = hrs > 0 ? `${hrs}:` : "";
  const mStr = `${mins.toString().padStart(2, "0")}:`;
  const sStr = secs.toString().padStart(2, "0");

  if (showDecimals) {
    const ms = Math.floor((seconds % 1) * 10);
    return `${hStr}${mStr}${sStr}.${ms}`;
  }
  return `${hStr}${mStr}${sStr}`;
}

// Window resize listener
window.addEventListener("resize", () => {
  if (currentMetadata) {
    renderAllViews();
  }
});

// Automatically load the test file if present in dev environment
window.addEventListener("DOMContentLoaded", async () => {
  const testFile = "D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4";
  try {
    await loadMediaFile(testFile);
  } catch {
    // If not found, stay on file drop screen
  }
});
