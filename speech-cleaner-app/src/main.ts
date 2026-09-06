import { PlaybackMutes, muteIntervals } from "./playback-mutes";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

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
  timing_estimated?: boolean;
}

interface AnalysisResult {
  metadata: MediaMetadata;
  fillers: FillerItem[];
  audio_preview_path: string;
  peaks: number[];
  peak_interval_seconds?: number;
}

interface ProgressPayload {
  percent: number;
  stage: string;
}

let currentMetadata: MediaMetadata | null = null;
let currentFillers: FillerItem[] = [];
let audioPeaks: number[] = [];
let peakIntervalSeconds = 0.01;
let activeFillerId: string | null = null;
let previewTimeoutId: number | null = null;
let previewAnimationFrameId: number | null = null;
let previewStopCleanup: (() => void) | null = null;

// Primary audio element — drives all transport playback and region previews
const previewAudioPlayer = document.getElementById("previewAudioPlayer") as HTMLAudioElement;
const playbackMutes = new PlaybackMutes(previewAudioPlayer, () => muteIntervals(
  currentFillers, Math.max(0, Number((document.getElementById("paramPaddingBefore") as HTMLInputElement).value) || 0) / 1000,
  currentMetadata?.duration ?? 0,
));
(document.getElementById("paramPaddingBefore") as HTMLInputElement).addEventListener("input", () => playbackMutes.refresh());

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
let animationFrameId: number | null = null;
let isDraggingTimeline = false;
let isDraggingMinimap = false;
// Custom Mute 2-Click Interactive Mode State
let isCustomMuteMode = false;
let customMuteStep: "awaiting_start" | "awaiting_end" | "selected" = "awaiting_start";
let selectionStartTime: number | null = null;
let selectionEndTime: number | null = null;

// Edge dragging on existing regions
type ResizingEdge = { fillerId: string; edge: "start" | "end" } | null;
let resizingRegion: ResizingEdge = null;
// Edge dragging on current selection ("start", "end", or "move" to slide whole span)
let resizingSelectionEdge: "start" | "end" | "move" | null = null;
let dragSelectionOffset: number = 0;

// Tool & Selection DOM Elements
const timelineHintText = document.getElementById("timelineHintText") as HTMLElement;
const selectionActionBar = document.getElementById("selectionActionBar") as HTMLElement;
const selectionDurationText = document.getElementById("selectionDurationText") as HTMLElement;
const selPreviewBtn = document.getElementById("selPreviewBtn") as HTMLButtonElement;
const selAddMuteBtn = document.getElementById("selAddMuteBtn") as HTMLButtonElement;
const selCancelBtn = document.getElementById("selCancelBtn") as HTMLButtonElement;
const selectionHandleLeft = document.getElementById("selectionHandleLeft") as HTMLElement;
const selectionHandleRight = document.getElementById("selectionHandleRight") as HTMLElement;

// Toolbar Dedicated Custom Mute Controls
const toolbarCustomMuteControls = document.getElementById("toolbarCustomMuteControls") as HTMLElement;
const toolbarSelectionDurationText = document.getElementById("toolbarSelectionDurationText") as HTMLElement;
const toolbarSelPreviewBtn = document.getElementById("toolbarSelPreviewBtn") as HTMLButtonElement;
const toolbarSelAddMuteBtn = document.getElementById("toolbarSelAddMuteBtn") as HTMLButtonElement;
const toolbarSelCancelBtn = document.getElementById("toolbarSelCancelBtn") as HTMLButtonElement;

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
    currentFillers = result.fillers.map(f => ({ ...f, enabled: false }));
    audioPeaks = result.peaks && result.peaks.length > 0 ? result.peaks : [];
    peakIntervalSeconds = result.peak_interval_seconds ?? result.metadata.duration / Math.max(1, audioPeaks.length);
    activeFillerId = null;

    // Wire preview audio to the full-quality WAV produced by the analysis
    previewAudioPlayer.src = convertFileSrc(result.audio_preview_path);
    previewAudioPlayer.load();

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
  currentTime = 0;
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
  zoomSlider.max = Math.max(100, currentMetadata?.duration ?? 100).toString();
  zoomSlider.value = "1";
  zoomLevelDisplay.innerText = "1.0x";

  renderFillersList();
  renderAllViews();
  updateSummary();
  updatePlayhead(0);
}

// -------------------------------------------------------------
// Synchronized Video & Audio Transport Logic — Web Audio API
// -------------------------------------------------------------
async function playAudio(fromTime?: number) {
  if (!currentMetadata || !previewAudioPlayer.src) return;

  const seekTime = fromTime !== undefined ? fromTime : currentTime;
  currentTime = seekTime;

  // Cancel any active preview snippet
  if (previewStopCleanup) {
    previewStopCleanup();
    previewStopCleanup = null;
  }
  if (previewTimeoutId !== null) {
    clearTimeout(previewTimeoutId);
    previewTimeoutId = null;
  }
  if (previewAnimationFrameId !== null) {
    cancelAnimationFrame(previewAnimationFrameId);
    previewAnimationFrameId = null;
  }

  previewAudioPlayer.currentTime = seekTime;
  try {
    await playbackMutes.start();
    await previewAudioPlayer.play();
    playbackMutes.refresh();
  } catch (err) {
    playbackMutes.stop();
    console.error("Play audio failed:", err);
    return;
  }

  if (isVideoVisible && videoPreviewPlayer.src && !isNaN(videoPreviewPlayer.duration)) {
    videoPreviewPlayer.currentTime = seekTime;
    videoPreviewPlayer.play().catch(() => {});
  }

  isPlaying = true;
  updateTransportUI();
  startPlayheadLoop();
}

async function pauseAudio() {
  playbackMutes.stop();
  // Cancel any active preview snippet
  if (previewStopCleanup) {
    previewStopCleanup();
    previewStopCleanup = null;
  }
  if (previewTimeoutId !== null) {
    clearTimeout(previewTimeoutId);
    previewTimeoutId = null;
  }
  if (previewAnimationFrameId !== null) {
    cancelAnimationFrame(previewAnimationFrameId);
    previewAnimationFrameId = null;
  }

  if (!isPlaying) {
    // Still stop the audio element in case a preview is running
    previewAudioPlayer.pause();
    return;
  }

  isPlaying = false;
  previewAudioPlayer.pause();

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
  if (previewStopCleanup) previewStopCleanup();
  currentTime = clamped;
  previewAudioPlayer.currentTime = clamped;
  playbackMutes.refresh();

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
  const totalTrackW = getTrackWidth();
  const px = ratio * totalTrackW;
  playheadLine.style.left = `${px}px`;

  // Auto-scroll waveform viewport during playback if zoomed in
  if ((isPlaying || previewStopCleanup !== null) && zoomLevel > 1.0) {
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

    // Read directly from the audio element — eliminates performance.now() drift
    const nowPos = previewAudioPlayer.currentTime;

    if (previewAudioPlayer.ended || nowPos >= currentMetadata.duration) {
      pauseAudio();
      seekTo(currentMetadata.duration);
      return;
    }

    currentTime = nowPos;
    followDetectionAtTime(nowPos);
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

// Global Keyboard Shortcuts (Space: Play/Pause or Preview selection, Enter: Apply Mute, Esc: Cancel)
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  const activeEl = document.activeElement as HTMLElement | null;
  const isInputActive = activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");

  if (e.code === "Space" && !isInputActive) {
    e.preventDefault();
    if (selectionStartTime !== null && selectionEndTime !== null && Math.abs(selectionEndTime - selectionStartTime) > 0.04) {
      // If a range is selected, Space auditions that clip
      previewRegion(Math.min(selectionStartTime, selectionEndTime), Math.max(selectionStartTime, selectionEndTime));
    } else {
      if (isPlaying) pauseAudio();
      else playAudio();
    }
  } else if (e.key === "Enter" && !isInputActive) {
    if (selectionStartTime !== null && selectionEndTime !== null && Math.abs(selectionEndTime - selectionStartTime) > 0.04) {
      e.preventDefault();
      commitSelectionAsMute();
    }
  } else if (e.key === "Escape") {
    exitCustomMuteMode();
  }
});

// -------------------------------------------------------------
// High-Precision Waveform Zoom & Navigation Engine
// -------------------------------------------------------------
function setZoom(newZoom: number, anchorRatio: number = 0.5) {
  if (!currentMetadata) return;
  const viewportW = waveformViewport.clientWidth || 800;
  // Only the viewport is painted, so long recordings can zoom to word scale.
  const maxSafeZoom = Math.max(100, currentMetadata.duration);
  zoomSlider.max = maxSafeZoom.toString();
  const clamped = Math.max(1.0, Math.min(maxSafeZoom, newZoom));
  const oldZoom = zoomLevel;
  zoomLevel = clamped;

  zoomSlider.value = zoomLevel.toString();
  zoomLevelDisplay.innerText = `${zoomLevel.toFixed(1)}x`;

  // Preserve scroll anchor location under mouse cursor
  const oldScrollLeft = waveformViewport.scrollLeft;
  const anchorX = oldScrollLeft + viewportW * anchorRatio;
  const anchorTimeRatio = anchorX / (viewportW * oldZoom);

  renderWaveformTrack();
  renderRuler();
  updateMinimapViewport();
  updateSelectionUI();

  const newTotalW = Math.round(viewportW * zoomLevel);
  waveformViewport.scrollLeft = Math.max(0, anchorTimeRatio * newTotalW - viewportW * anchorRatio);
  renderWaveformTrack();
  renderRuler();
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

// MouseWheel / Ctrl+MouseWheel to zoom; Shift+MouseWheel to horizontal pan
waveformViewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      // Shift + Wheel = horizontal pan
      waveformViewport.scrollLeft += e.deltaY;
    } else {
      // Direct wheel or Ctrl + wheel = zoom centered at mouse position
      const rect = waveformViewport.getBoundingClientRect();
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      setZoom(zoomLevel * zoomFactor, mouseRatio);
    }
  },
  { passive: false }
);

waveformViewport.addEventListener("scroll", () => {
  renderWaveformTrack();
  updateMinimapViewport();
  renderRuler();
  updateSelectionUI();
});

// -------------------------------------------------------------
// Waveform Rendering (Adaptive True Peaks + Mute Regions)
// -------------------------------------------------------------
function renderAllViews() {
  renderWaveformTrack();
  renderMinimap();
  renderRuler();
  updateSelectionUI();
}

function getTrackWidth(): number {
  return Math.max(1, Math.round((waveformViewport.clientWidth || 800) * zoomLevel));
}

function peakBetween(start: number, end: number): number {
  const a = Math.max(0, Math.floor(start / peakIntervalSeconds));
  const b = Math.min(audioPeaks.length, Math.max(a + 1, Math.ceil(end / peakIntervalSeconds)));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, audioPeaks[i]);
  return peak;
}

function renderWaveformTrack() {
  if (!currentMetadata) return;
  const viewportW = waveformViewport.clientWidth || 800;
  const totalTrackW = getTrackWidth();
  const trackHeight = waveformCanvas.offsetHeight || 110;
  waveformContainer.style.width = `${totalTrackW}px`;
  waveformCanvas.width = viewportW;
  waveformCanvas.height = trackHeight;
  const scrollLeft = waveformViewport.scrollLeft;
  const ctx = waveformCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, viewportW, trackHeight);
  ctx.fillStyle = "#334155";
  const secondsPerPixel = currentMetadata.duration / totalTrackW;
  for (let x = 0; x < viewportW; x++) {
    const amp = peakBetween((scrollLeft + x) * secondsPerPixel, (scrollLeft + x + 1) * secondsPerPixel);
    const barH = Math.max(1, Math.min(1, amp * 1.25) * trackHeight * 0.8);
    ctx.fillRect(x, (trackHeight - barH) / 2, 1, barH);
  }

  // 2. Draw Active Mute Zones
  const duration = currentMetadata.duration;

  currentFillers.forEach((f) => {
    const startX = (f.start / duration) * totalTrackW - scrollLeft;
    const endX = (f.end / duration) * totalTrackW - scrollLeft;
    const zoneW = Math.max(endX - startX, 4);
    if (startX > viewportW || startX + zoneW < 0) return;

    if (f.enabled) {
      // Applied mutes are yellow; detected but unapplied regions remain red.
      ctx.fillStyle = "rgba(250, 204, 21, 0.35)";
      ctx.fillRect(startX, 0, zoneW, trackHeight);

      ctx.strokeStyle = "#FACC15";
      ctx.lineWidth = 1;
      ctx.strokeRect(startX, 0, zoneW, trackHeight);

      // Draw subtle draggable edge grip handles on left and right borders
      ctx.fillStyle = "#FDE68A";
      ctx.fillRect(startX, 0, 3, trackHeight);
      ctx.fillRect(startX + zoneW - 3, 0, 3, trackHeight);

      // Label badge — clipped to zone width so it never overflows into adjacent words
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, 0, zoneW, trackHeight);
      ctx.clip();

      ctx.font = "bold 10px JetBrains Mono, monospace";
      const label = f.word.toUpperCase();
      const textW = ctx.measureText(label).width;

      // Only draw label pill if zone is wide enough to show at least 2 chars
      if (zoneW >= 6) {
        const pillW = Math.min(textW + 6, zoneW - 2);
        const pillH = 14;
        const pillX = startX + 1;
        const pillY = 1;
        const pillColor = "rgba(161, 98, 7, 0.95)";

        ctx.fillStyle = pillColor;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 3);
        ctx.fill();

        ctx.fillStyle = "#FFF";
        ctx.fillText(label, pillX + 3, pillY + 10);
      }

      ctx.restore();
    } else {
      // Unapplied detection: audible until Apply is pressed.
      ctx.fillStyle = "rgba(225, 29, 72, 0.2)";
      ctx.fillRect(startX, 0, zoneW, trackHeight);
      ctx.strokeStyle = "rgba(225, 29, 72, 0.7)";
      ctx.strokeRect(startX, 0, zoneW, trackHeight);
    }
    if (f.id === activeFillerId) {
      ctx.strokeStyle = "#22D3EE";
      ctx.lineWidth = 2;
      ctx.strokeRect(startX, 1, zoneW, trackHeight - 2);
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
    const amp = peakBetween(progress * currentMetadata.duration, ((i + 1) / bars) * currentMetadata.duration);
    const h = Math.max(2, amp * (height * 0.85));
    const y = (height - h) / 2;
    ctx.fillRect(i * barW, y, barW - 0.5, h);
  }

  // Draw mute regions on minimap
  const duration = currentMetadata.duration;
  currentFillers.forEach((f) => {
    const startX = (f.start / duration) * width;
    const endX = (f.end / duration) * width;
    ctx.fillStyle = f.enabled ? "#FACC15" : "rgba(225, 29, 72, 0.8)";
    ctx.fillRect(startX, 0, Math.max(endX - startX, 2), height);
  });

  updateMinimapViewport();
}

function updateMinimapViewport() {
  if (!currentMetadata) return;
  const viewportW = waveformViewport.clientWidth;
  const totalTrackW = getTrackWidth();
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
  } else if ((resizingRegion || resizingSelectionEdge) && currentMetadata) {
    // Forward to waveform mousemove tracking logic so handle dragging is smooth everywhere
    const t = getTimestampFromClientX(e.clientX);
    if (resizingRegion) {
      const filler = currentFillers.find((f) => f.id === resizingRegion!.fillerId);
      if (filler) {
        if (resizingRegion.edge === "start") {
          filler.start = Math.max(0, Math.min(t, filler.end - 0.05));
        } else {
          filler.end = Math.min(currentMetadata.duration, Math.max(t, filler.start + 0.05));
        }
        filler.timing_estimated = false;
        timelineHoverTooltip.innerText = `${resizingRegion.edge.toUpperCase()}: ${formatTimecode(resizingRegion.edge === "start" ? filler.start : filler.end)}`;
        renderWaveformTrack();
        renderMinimap();
        renderFillersList();
        updateSummary();
      }
    } else if (resizingSelectionEdge) {
      if (resizingSelectionEdge === "start") {
        selectionStartTime = Math.max(0, Math.min(t, (selectionEndTime ?? t) - 0.04));
      } else if (resizingSelectionEdge === "end") {
        selectionEndTime = Math.min(currentMetadata.duration, Math.max(t, (selectionStartTime ?? t) + 0.04));
      } else if (resizingSelectionEdge === "move") {
        const dur = Math.abs((selectionEndTime ?? 0) - (selectionStartTime ?? 0));
        const newStart = Math.max(0, Math.min(currentMetadata.duration - dur, t - dragSelectionOffset));
        selectionStartTime = newStart;
        selectionEndTime = newStart + dur;
      }
      updateSelectionUI();
      const s = Math.min(selectionStartTime!, selectionEndTime!);
      const endT = Math.max(selectionStartTime!, selectionEndTime!);
      timelineHoverTooltip.innerText = `SPAN: ${formatTimecode(s)} → ${formatTimecode(endT)} (${(endT - s).toFixed(2)}s)`;
    }
  }
});

window.addEventListener("mouseup", () => {
  isDraggingMinimap = false;
});

function handleMinimapClick(e: MouseEvent) {
  const rect = minimapContainer.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const totalTrackW = getTrackWidth();
  const viewportW = waveformViewport.clientWidth;

  waveformViewport.scrollLeft = ratio * totalTrackW - viewportW / 2;
  seekTo(ratio * (currentMetadata?.duration || 0));
}

// -------------------------------------------------------------
// Adaptive Timecode Ruler
// -------------------------------------------------------------
function renderRuler() {
  if (!currentMetadata) return;

  // Use clientWidth (excludes borders/scrollbar) to match waveformViewport.clientWidth
  // so ruler ticks align exactly with waveform canvas coordinates
  const width = (rulerCanvas.width = rulerCanvas.clientWidth || rulerCanvas.offsetWidth);
  const height = (rulerCanvas.height = rulerCanvas.clientHeight || rulerCanvas.offsetHeight);
  const ctx = rulerCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  const duration = currentMetadata.duration;
  const viewportW = waveformViewport.clientWidth;
  const totalTrackW = getTrackWidth();
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

// Helper: find if mouse is near the left or right edge of an existing mute region
function findRegionEdgeNearX(clickTime: number, totalTrackW: number, tolerancePx: number = 5): { filler: FillerItem; edge: "start" | "end" } | null {
  if (!currentMetadata) return null;
  const duration = currentMetadata.duration;
  const toleranceSec = (tolerancePx / totalTrackW) * duration;

  for (const f of currentFillers) {
    if (f.id !== activeFillerId || (f.end - f.start) / duration * totalTrackW < 18) continue;
    if (Math.abs(clickTime - f.start) <= toleranceSec) {
      return { filler: f, edge: "start" };
    }
    if (Math.abs(clickTime - f.end) <= toleranceSec) {
      return { filler: f, edge: "end" };
    }
  }
  return null;
}

waveformContainer.addEventListener("mousemove", (e) => {
  if (!currentMetadata) return;
  const t = getTimestampFromClientX(e.clientX);
  const rect = waveformContainer.getBoundingClientRect();
  const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const totalTrackW = getTrackWidth();

  timelineHoverTooltip.style.display = "block";
  timelineHoverTooltip.style.left = `${relX}px`;

  // 1. If currently dragging an existing region edge
  if (resizingRegion) {
    const filler = currentFillers.find((f) => f.id === resizingRegion!.fillerId);
    if (filler) {
      if (resizingRegion.edge === "start") {
        filler.start = Math.max(0, Math.min(t, filler.end - 0.05));
      } else {
        filler.end = Math.min(currentMetadata.duration, Math.max(t, filler.start + 0.05));
      }
      filler.timing_estimated = false;
      timelineHoverTooltip.innerText = `${resizingRegion.edge.toUpperCase()}: ${formatTimecode(resizingRegion.edge === "start" ? filler.start : filler.end)}`;
      renderWaveformTrack();
      renderMinimap();
      renderFillersList();
      updateSummary();
    }
    return;
  }

  // 2. If currently dragging selection handle or moving whole selection
  if (resizingSelectionEdge) {
    if (resizingSelectionEdge === "start") {
      selectionStartTime = Math.max(0, Math.min(t, (selectionEndTime ?? t) - 0.04));
    } else if (resizingSelectionEdge === "end") {
      selectionEndTime = Math.min(currentMetadata.duration, Math.max(t, (selectionStartTime ?? t) + 0.04));
    } else if (resizingSelectionEdge === "move") {
      const dur = Math.abs((selectionEndTime ?? 0) - (selectionStartTime ?? 0));
      const newStart = Math.max(0, Math.min(currentMetadata.duration - dur, t - dragSelectionOffset));
      selectionStartTime = newStart;
      selectionEndTime = newStart + dur;
    }
    updateSelectionUI();
    const s = Math.min(selectionStartTime!, selectionEndTime!);
    const e = Math.max(selectionStartTime!, selectionEndTime!);
    timelineHoverTooltip.innerText = `SPAN: ${formatTimecode(s)} → ${formatTimecode(e)} (${(e - s).toFixed(2)}s)`;
    return;
  }

  // 3. If in custom mute mode
  if (isCustomMuteMode) {
    if (customMuteStep === "awaiting_start") {
      timelineHoverTooltip.innerText = `CLICK OR DRAG START: ${formatTimecode(t)}`;
      waveformContainer.style.cursor = "crosshair";
    } else if (customMuteStep === "awaiting_end" && selectionStartTime !== null) {
      selectionEndTime = t;
      updateSelectionUI();
      const s = Math.min(selectionStartTime, selectionEndTime);
      const endT = Math.max(selectionStartTime, selectionEndTime);
      timelineHoverTooltip.innerText = `RELEASE OR CLICK END: ${formatTimecode(t)} (${(endT - s).toFixed(2)}s)`;
      waveformContainer.style.cursor = "crosshair";
      return;
    } else if (customMuteStep === "selected") {
      timelineHoverTooltip.innerText = formatTimecode(t);
      // Check if mouse is near start or end edge of selection
      if (selectionStartTime !== null && selectionEndTime !== null) {
        const s = Math.min(selectionStartTime, selectionEndTime);
        const endT = Math.max(selectionStartTime, selectionEndTime);
        const toleranceSec = (12 / totalTrackW) * currentMetadata.duration;
        if (Math.abs(t - s) <= toleranceSec || Math.abs(t - endT) <= toleranceSec) {
          waveformContainer.style.cursor = "ew-resize";
        } else if (t >= s && t <= endT) {
          waveformContainer.style.cursor = "grab";
        } else {
          waveformContainer.style.cursor = "default";
        }
      } else {
        waveformContainer.style.cursor = "default";
      }
    }
  } else {
    timelineHoverTooltip.innerText = formatTimecode(t);
    if (!isDraggingTimeline) {
      const nearEdge = findRegionEdgeNearX(t, totalTrackW);
      if (nearEdge) {
        waveformContainer.style.cursor = "ew-resize";
      } else {
        waveformContainer.style.cursor = "default";
      }
    }
  }

  if (isDraggingTimeline) {
    seekTo(t);
  }
});

waveformContainer.addEventListener("mouseleave", () => {
  timelineHoverTooltip.style.display = "none";
});

waveformContainer.addEventListener("mousedown", (e) => {
  if (!currentMetadata) return;
  const clickTime = getTimestampFromClientX(e.clientX);
  const totalTrackW = getTrackWidth();

  // If user is already dragging selection handles, let it proceed
  if (resizingSelectionEdge) return;

  // If in custom mute mode:
  if (isCustomMuteMode) {
    if (e.button !== 0) return; // Left click only
    e.preventDefault();

    if (customMuteStep === "awaiting_start") {
      // Start of selection (works for both click-and-drag and 2-click)
      selectionStartTime = clickTime;
      selectionEndTime = clickTime;
      customMuteStep = "awaiting_end";
      timelineHintText.innerText = "Drag to end point and release, or click again at the end point";
      updateSelectionUI();
    } else if (customMuteStep === "awaiting_end") {
      // 2nd click: finalize end of selection
      selectionEndTime = clickTime;
      const s = Math.min(selectionStartTime!, selectionEndTime);
      const endT = Math.max(selectionStartTime!, selectionEndTime);
      selectionStartTime = s;
      selectionEndTime = Math.max(s + 0.05, endT);
      customMuteStep = "selected";
      waveformContainer.style.cursor = "default";
      timelineHintText.innerText = "Area selected! Drag handles to adjust, then click 'Apply Mute' (or press Enter)";
      updateSelectionUI();
    } else if (customMuteStep === "selected") {
      if (selectionStartTime !== null && selectionEndTime !== null) {
        const s = Math.min(selectionStartTime, selectionEndTime);
        const endT = Math.max(selectionStartTime, selectionEndTime);
        const toleranceSec = (12 / totalTrackW) * currentMetadata.duration;

        // Check if user clicked near start handle
        if (Math.abs(clickTime - s) <= toleranceSec) {
          resizingSelectionEdge = "start";
          return;
        }
        // Check if user clicked near end handle
        if (Math.abs(clickTime - endT) <= toleranceSec) {
          resizingSelectionEdge = "end";
          return;
        }
        // Check if user clicked inside the selection box to slide it
        if (clickTime > s && clickTime < endT) {
          resizingSelectionEdge = "move";
          dragSelectionOffset = clickTime - s;
          return;
        }
      }
      // Clicked far outside: start a fresh custom selection
      selectionStartTime = clickTime;
      selectionEndTime = clickTime;
      customMuteStep = "awaiting_end";
      timelineHintText.innerText = "Drag to end point and release, or click again at the end point";
      updateSelectionUI();
    }
    return;
  }

  const hit = findRegionAtTime(clickTime);
  if ((e.button === 2 || e.shiftKey) && hit) {
    currentFillers = currentFillers.filter(f => f.id !== hit.id);
    renderFillersList();
    updateSummary();
    renderAllViews();
    return;
  }
  if (e.button !== 0) return;
  const edgeHit = findRegionEdgeNearX(clickTime, totalTrackW);
  if (edgeHit) {
    selectFiller(edgeHit.filler.id, false);
    resizingRegion = { fillerId: edgeHit.filler.id, edge: edgeHit.edge };
    return;
  }
  if (hit) {
    selectFiller(hit.id);
    seekTo(hit.start);
    return;
  }

  // Normal scrub / playhead repositioning
  isDraggingTimeline = true;
  seekTo(clickTime);
});

window.addEventListener("mouseup", () => {
  if (resizingRegion) {
    resizingRegion = null;
    waveformContainer.style.cursor = "default";
  }

  if (resizingSelectionEdge) {
    resizingSelectionEdge = null;
    waveformContainer.style.cursor = "default";
  }

  // If in custom mute mode and awaiting end, check if the user did a click-and-drag
  if (isCustomMuteMode && customMuteStep === "awaiting_end") {
    if (selectionStartTime !== null && selectionEndTime !== null) {
      const s = Math.min(selectionStartTime, selectionEndTime);
      const endT = Math.max(selectionStartTime, selectionEndTime);
      const dur = endT - s;
      // If user dragged more than 0.05s, finalize into "selected" state on mouse release!
      if (dur >= 0.05) {
        selectionStartTime = s;
        selectionEndTime = endT;
        customMuteStep = "selected";
        waveformContainer.style.cursor = "default";
        timelineHintText.innerText = "Area selected! Drag handles to adjust, then click 'Apply Mute' (or press Enter)";
        updateSelectionUI();
      }
    }
  }

  if (isDraggingTimeline) {
    isDraggingTimeline = false;
  }
});

// Update selection overlay and handles
function updateSelectionUI() {
  if (!currentMetadata || selectionStartTime === null || selectionEndTime === null) {
    timelineSelection.style.display = "none";
    selectionActionBar.style.display = "none";
    return;
  }

  const duration = currentMetadata.duration;
  const totalTrackW = getTrackWidth();
  const s = Math.max(0, Math.min(selectionStartTime, selectionEndTime));
  const e = Math.min(duration, Math.max(selectionStartTime, selectionEndTime));

  const leftPx = (s / duration) * totalTrackW;
  const rightPx = (e / duration) * totalTrackW;
  const widthPx = Math.max(2, rightPx - leftPx);

  timelineSelection.style.display = "block";
  timelineSelection.style.left = `${leftPx}px`;
  timelineSelection.style.width = `${widthPx}px`;

  showSelectionActionBar();
}

function showSelectionActionBar() {
  if (!currentMetadata || selectionStartTime === null || selectionEndTime === null) return;
  const duration = currentMetadata.duration;
  const totalTrackW = getTrackWidth();
  const s = Math.max(0, Math.min(selectionStartTime, selectionEndTime));
  const e = Math.min(duration, Math.max(selectionStartTime, selectionEndTime));
  const selDur = e - s;

  if (selDur <= 0.03) {
    selectionActionBar.style.display = "none";
    toolbarCustomMuteControls.style.display = "none";
    return;
  }

  const scrollLeft = waveformViewport.scrollLeft;
  const viewportW = waveformViewport.clientWidth;
  const leftPx = (s / duration) * totalTrackW;
  const rightPx = (e / duration) * totalTrackW;
  const midX = (leftPx + rightPx) / 2;

  // Compute screen X position relative to waveformViewport container
  const screenMidX = midX - scrollLeft;
  const barW = 270;
  const clampedScreenX = Math.max(10, Math.min(viewportW - barW - 10, screenMidX - barW / 2));

  const durStr = `${formatTimecode(s)} → ${formatTimecode(e)} (${selDur.toFixed(2)}s)`;
  selectionDurationText.innerText = durStr;
  toolbarSelectionDurationText.innerText = durStr;

  // Show both the floating bar above the selection AND the fixed toolbar controls
  selectionActionBar.style.display = "flex";
  selectionActionBar.style.left = `${clampedScreenX}px`;
  toolbarCustomMuteControls.style.display = "flex";
}

function clearSelectionRange() {
  selectionStartTime = null;
  selectionEndTime = null;
  timelineSelection.style.display = "none";
  selectionActionBar.style.display = "none";
  toolbarCustomMuteControls.style.display = "none";
}

// Floating Action Bar Buttons
selPreviewBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (selectionStartTime !== null && selectionEndTime !== null) {
    const s = Math.min(selectionStartTime, selectionEndTime);
    const end = Math.max(selectionStartTime, selectionEndTime);
    previewRegion(s, end);
  }
});

selAddMuteBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  commitSelectionAsMute();
});

selCancelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exitCustomMuteMode();
});

// Toolbar Dedicated Custom Mute Buttons
toolbarSelPreviewBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (selectionStartTime !== null && selectionEndTime !== null) {
    const s = Math.min(selectionStartTime, selectionEndTime);
    const end = Math.max(selectionStartTime, selectionEndTime);
    previewRegion(s, end);
  }
});

toolbarSelAddMuteBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  commitSelectionAsMute();
});

toolbarSelCancelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exitCustomMuteMode();
});

function enterCustomMuteMode() {
  isCustomMuteMode = true;
  customMuteStep = "awaiting_start";
  selectionStartTime = null;
  selectionEndTime = null;
  timelineSelection.style.display = "none";
  selectionActionBar.style.display = "none";
  openAddCustomModalBtn.classList.add("custom-mute-armed");
  openAddCustomModalBtn.innerHTML = `✕ Cancel Custom Mute`;
  waveformContainer.style.cursor = "crosshair";
  timelineHintText.innerText = "Click on the audio timeline to set the START of your custom mute";
}

function exitCustomMuteMode() {
  isCustomMuteMode = false;
  customMuteStep = "awaiting_start";
  clearSelectionRange();
  openAddCustomModalBtn.classList.remove("custom-mute-armed");
  openAddCustomModalBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    + Add Custom Mute
  `;
  waveformContainer.style.cursor = "default";
  timelineHintText.innerText = "Scroll to Zoom • Drag region edges to resize";
}

function commitSelectionAsMute() {
  if (!currentMetadata || selectionStartTime === null || selectionEndTime === null) return;
  const s = Math.min(selectionStartTime, selectionEndTime);
  const e = Math.max(selectionStartTime, selectionEndTime);
  if (e - s < 0.04) return;

  const newItem: FillerItem = {
    id: `custom_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    word: "custom",
    start: s,
    end: e,
    confidence: 1.0,
    enabled: true,
  };

  currentFillers.push(newItem);
  currentFillers.sort((a, b) => a.start - b.start);

  exitCustomMuteMode();
  renderFillersList();
  updateSummary();
  renderAllViews();
}

// Dragging selection left/right handles
selectionHandleLeft.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  e.preventDefault();
  resizingSelectionEdge = "start";
});

selectionHandleRight.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  e.preventDefault();
  resizingSelectionEdge = "end";
});

// Dragging the whole selection area body
timelineSelection.addEventListener("mousedown", (e) => {
  if (e.target === selectionHandleLeft || e.target === selectionHandleRight) return;
  if (!currentMetadata || selectionStartTime === null || selectionEndTime === null) return;
  e.stopPropagation();
  e.preventDefault();
  const clickTime = getTimestampFromClientX(e.clientX);
  const s = Math.min(selectionStartTime, selectionEndTime);
  resizingSelectionEdge = "move";
  dragSelectionOffset = clickTime - s;
});

// Toggle Custom Mute Mode via Button
openAddCustomModalBtn.addEventListener("click", () => {
  if (isCustomMuteMode) {
    exitCustomMuteMode();
  } else {
    enterCustomMuteMode();
  }
});

waveformContainer.addEventListener("contextmenu", (e) => e.preventDefault());

// Double click previews the selected region; deletion stays on explicit controls.
waveformContainer.addEventListener("dblclick", () => {
  const item = currentFillers.find(f => f.id === activeFillerId);
  if (item && !isCustomMuteMode) previewRegion(item.start, item.end);
});

// -------------------------------------------------------------
// Manual Addition Controls
// -------------------------------------------------------------

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
function findRegionAtTime(time: number): FillerItem | undefined {
  if (!currentMetadata) return;
  const pixelsPerSecond = getTrackWidth() / currentMetadata.duration;
  const x = Math.round(time * pixelsPerSecond);
  // MouseEvent coordinates are rounded to pixels. Include every painted pixel
  // of the minimum-width overview marker, even if the word spans a fraction.
  return currentFillers.filter(f => x >= Math.floor(f.start * pixelsPerSecond)
      && x <= Math.ceil(Math.max(f.end * pixelsPerSecond, f.start * pixelsPerSecond + 4)))
    .sort((a, b) => Math.abs(time - (a.start + a.end) / 2) - Math.abs(time - (b.start + b.end) / 2))[0];
}

function revealTimeline(start: number, end: number) {
  if (!currentMetadata) return;
  // Show enough context to hear and edit a word, retaining a closer user zoom.
  const visibleSeconds = Math.max(8, end - start + 4);
  if (currentMetadata.duration / zoomLevel > visibleSeconds) {
    setZoom(currentMetadata.duration / visibleSeconds);
  }
  const centerPx = ((start + end) / 2) / currentMetadata.duration * getTrackWidth();
  waveformViewport.scrollLeft = Math.max(0, centerPx - waveformViewport.clientWidth / 2);
  renderWaveformTrack();
  renderRuler();
}

function selectFiller(id: string, revealWaveform = true, scrollList = true) {
  const item = currentFillers.find(f => f.id === id);
  if (!item) return;
  activeFillerId = id;
  for (const row of detectionList.querySelectorAll<HTMLElement>(".detection-item")) {
    const active = row.dataset.fillerId === id;
    row.classList.toggle("active", active);
    if (active) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
    if (active && scrollList) {
      const r = row.getBoundingClientRect();
      const list = detectionList.getBoundingClientRect();
      if (r.top < list.top || r.bottom > list.bottom) {
        detectionList.scrollTop += r.top - list.top - (detectionList.clientHeight - r.height) / 2;
      }
    }
  }
  if (revealWaveform) revealTimeline(item.start, item.end);
  else renderWaveformTrack();
}

function followDetectionAtTime(time: number) {
  const item = currentFillers.find(f => time >= f.start && time <= f.end);
  if (item && item.id !== activeFillerId) selectFiller(item.id, false);
}

function renderFillersList() {
  const listScrollTop = detectionList.scrollTop;
  detectionList.innerHTML = "";
  regionsCountBadge.innerText = currentFillers.length.toString();

  currentFillers.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = `detection-item ${item.enabled ? "applied" : "disabled"} ${item.id === activeFillerId ? "active" : ""}`;
    el.dataset.fillerId = item.id;
    el.tabIndex = 0;
    if (item.id === activeFillerId) el.setAttribute("aria-current", "true");

    const dur = Math.max(0.01, item.end - item.start);
    const confPct = Math.round(item.confidence * 100);
    const isCustom = item.id.startsWith("custom_");

    el.innerHTML = `
      <div class="detection-left">
        <label class="checkbox-container">
          <input type="checkbox" aria-label="Apply mute" ${item.enabled ? "checked" : ""} data-id="${item.id}" />
          <span class="checkmark"></span>
        </label>
        <span class="filler-badge ${isCustom ? "custom-badge" : ""}">${item.word}</span>
        <div class="detection-timestamps">
          <span>${formatTimecode(item.start)} → ${formatTimecode(item.end)}</span>
        </div>
        <span class="detection-duration">(${dur.toFixed(2)}s)</span>
      </div>
      <div class="detection-right">
        <span class="confidence-indicator">${isCustom ? "Manual" : item.timing_estimated ? "Review timing" : `${confPct}%`}</span>
        <button class="btn-preview" title="Preview original audio" data-start="${item.start}" data-end="${item.end}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
        <button class="btn-apply ${item.enabled ? "is-applied" : ""}" aria-pressed="${item.enabled}">${item.enabled ? "Unapply" : "Apply"}</button>
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
      syncAppliedRow();
      updateSummary();
      renderAllViews();
    });

    const applyBtn = el.querySelector(".btn-apply") as HTMLButtonElement;
    function syncAppliedRow() {
      el.classList.toggle("disabled", !item.enabled);
      el.classList.toggle("applied", item.enabled);
      cb.checked = item.enabled;
      applyBtn.textContent = item.enabled ? "Unapply" : "Apply";
      applyBtn.classList.toggle("is-applied", item.enabled);
      applyBtn.setAttribute("aria-pressed", String(item.enabled));
    }
    applyBtn.addEventListener("click", e => {
      e.stopPropagation();
      item.enabled = !item.enabled;
      syncAppliedRow();
      updateSummary();
      renderAllViews();
    });

    const prevBtn = el.querySelector(".btn-preview") as HTMLButtonElement;
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectFiller(item.id);
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

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, label")) return;
      selectFiller(item.id);
      seekTo(item.start);
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      selectFiller(item.id);
      seekTo(item.start);
    });

    detectionList.appendChild(el);
  });
  detectionList.scrollTop = listScrollTop;
}

function updateSummary() {
  playbackMutes.refresh();
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
    f.enabled = !f.timing_estimated && f.confidence >= 0.75;
  });
  renderFillersList();
  updateSummary();
  renderAllViews();
});

// -------------------------------------------------------------
// Audio Preview of Exact Muted Region — uses HTMLAudioElement directly
// -------------------------------------------------------------
async function previewRegion(start: number, end: number, btn?: HTMLButtonElement) {
  if (!currentMetadata || !previewAudioPlayer.src) return;

  // Clean up any existing preview or transport playback
  if (previewStopCleanup) {
    previewStopCleanup();
    previewStopCleanup = null;
  }
  if (previewTimeoutId !== null) {
    clearTimeout(previewTimeoutId);
    previewTimeoutId = null;
  }
  if (previewAnimationFrameId !== null) {
    cancelAnimationFrame(previewAnimationFrameId);
    previewAnimationFrameId = null;
  }

  previewAudioPlayer.pause();
  videoPreviewPlayer.pause();
  if (isPlaying) {
    isPlaying = false;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    updateTransportUI();
  }

  // Padding only applies to detected words; for precise custom selection, we give a tiny 50ms buffer at end
  const paddingMs = parseFloat((document.getElementById("paramPaddingBefore") as HTMLInputElement)?.value) || 30;
  const padSec = paddingMs / 1000.0;

  const playStart = Math.max(0, start - padSec);
  // Guarantee preview plays at least through the entire selected end plus 80ms so the last syllable isn't cut off
  const playEnd = Math.min(currentMetadata.duration, end + Math.max(0.08, padSec));

  const matchingItem = currentFillers.find(f => f.start === start && f.end === end);
  if (matchingItem) selectFiller(matchingItem.id);
  else revealTimeline(start, end);

  // Move visual playhead to preview start
  updatePlayhead(playStart);
  currentTime = playStart;

  let originalBtnHtml = "";
  if (btn) {
    originalBtnHtml = btn.innerHTML;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Playing`;
    btn.style.background = "var(--accent-blue)";
    btn.style.color = "#FFF";
  }

  const stopPreview = () => {
    previewAudioPlayer.pause();
    playbackMutes.stop();
    if (previewAnimationFrameId !== null) {
      cancelAnimationFrame(previewAnimationFrameId);
      previewAnimationFrameId = null;
    }
    if (previewTimeoutId !== null) {
      clearTimeout(previewTimeoutId);
      previewTimeoutId = null;
    }
    previewAudioPlayer.removeEventListener("timeupdate", onTimeUpdate);
    previewAudioPlayer.removeEventListener("ended", stopPreview);

    if (btn) {
      btn.innerHTML = originalBtnHtml;
      btn.style.background = "";
      btn.style.color = "";
    }
    previewStopCleanup = null;
  };

  previewStopCleanup = stopPreview;

  const onTimeUpdate = () => {
    const pos = previewAudioPlayer.currentTime;
    if (isVideoVisible && videoPreviewPlayer.src) videoPreviewPlayer.currentTime = pos;
    if (pos >= playEnd || previewAudioPlayer.ended) {
      stopPreview();
    } else {
      currentTime = pos;
      updatePlayhead(pos);
    }
  };

  const previewFrameLoop = () => {
    if (!previewStopCleanup) return;
    const pos = previewAudioPlayer.currentTime;
    if (isVideoVisible && videoPreviewPlayer.src) videoPreviewPlayer.currentTime = pos;
    if (pos >= playEnd || previewAudioPlayer.ended) {
      stopPreview();
      return;
    }
    currentTime = pos;
    followDetectionAtTime(pos);
    updatePlayhead(pos);
    previewAnimationFrameId = requestAnimationFrame(previewFrameLoop);
  };

  previewAudioPlayer.addEventListener("timeupdate", onTimeUpdate);
  previewAudioPlayer.addEventListener("ended", stopPreview);

  // Seek and play
  previewAudioPlayer.currentTime = playStart;
  try {
    await playbackMutes.start(true);
    if (previewStopCleanup !== stopPreview) return;
    await previewAudioPlayer.play();
    if (previewStopCleanup !== stopPreview) return;
    previewAnimationFrameId = requestAnimationFrame(previewFrameLoop);
    // Safety fallback timeout in case timeupdate is delayed by OS
    const maxSafetyDuration = Math.max(1.0, (playEnd - playStart) * 1.5 + 2.0);
    previewTimeoutId = window.setTimeout(stopPreview, maxSafetyDuration * 1000);
  } catch (err) {
    console.error("Preview audio error:", err);
    if (previewStopCleanup !== stopPreview) return;
    stopPreview();
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

    const paddingMs = Math.max(0, Number((document.getElementById("paramPaddingBefore") as HTMLInputElement).value) || 0);
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
  let dependenciesReady = true;
  try {
    const missing = await invoke<string[]>("check_dependencies");
    if (missing.length > 0) {
      dependenciesReady = false;
      dropSection.style.display = "none";
      selectFileBtn.disabled = true;
      const accepted = window.confirm(
        `Speech Cleaner needs to download its processing components before first use:\n\n` +
        `${missing.map((item) => `• ${item}`).join("\n")}\n\n` +
        `The download is approximately 700 MB and is installed only for your Windows account. Download now?`
      );
      if (accepted) {
        engineStatusLabel.textContent = "Installing processing components…";
        progressSection.style.display = "flex";
        cancelAnalysisBtn.style.display = "none";
        progressStatus.textContent = "Preparing component installation…";
        progressPercent.textContent = "0%";
        progressBar.style.width = "0%";
        const unlistenDependencyProgress = await listen<ProgressPayload>("dependency-progress", (event) => {
          const percent = Math.max(0, Math.min(100, Math.round(event.payload.percent)));
          progressStatus.textContent = event.payload.stage;
          progressPercent.textContent = `${percent}%`;
          progressBar.style.width = `${percent}%`;
        });
        try {
          await invoke("install_dependencies");
        } finally {
          unlistenDependencyProgress();
          cancelAnalysisBtn.style.display = "";
        }
        const remaining = await invoke<string[]>("check_dependencies");
        if (remaining.length > 0) {
          throw new Error(`Still missing: ${remaining.join(", ")}`);
        }
        dependenciesReady = true;
        dropSection.style.display = "flex";
        selectFileBtn.disabled = false;
        engineStatusLabel.textContent = "Engine Ready";
        progressStatus.textContent = "Processing components are ready.";
        progressPercent.textContent = "100%";
        progressBar.style.width = "100%";
        window.setTimeout(() => { progressSection.style.display = "none"; }, 1200);
        window.alert("Speech Cleaner is ready to use.");
      } else {
        engineStatusLabel.textContent = "Setup Required";
        progressSection.style.display = "flex";
        cancelAnalysisBtn.style.display = "none";
        progressStatus.textContent = "Processing components are required before importing media. Restart to install.";
        progressPercent.textContent = "Required";
        progressBar.style.width = "0%";
      }
    } else {
      dropSection.style.display = "flex";
      selectFileBtn.disabled = false;
    }
  } catch (error) {
    engineStatusLabel.textContent = "Setup Failed";
    progressSection.style.display = "flex";
    progressStatus.textContent = "Component installation failed. Restart to retry.";
    progressPercent.textContent = "Error";
    progressBar.style.width = "0%";
    window.alert(`Speech Cleaner could not install its processing components.\n\n${String(error)}\n\nRestart the app to try again.`);
  }

  if (!dependenciesReady) return;

  const testFile = "D:\\scratch\\Remove words\\Speech_Cleaner_Test.mp4";
  try {
    await loadMediaFile(testFile);
  } catch {
    // If not found, stay on file drop screen
  }
});

// -------------------------------------------------------------
// About Modal Dialog Management
// -------------------------------------------------------------
const aboutBtn = document.getElementById("aboutBtn") as HTMLButtonElement | null;
const aboutModal = document.getElementById("aboutModal") as HTMLElement | null;
const closeAboutModalBtn = document.getElementById("closeAboutModalBtn") as HTMLButtonElement | null;
const aboutOkBtn = document.getElementById("aboutOkBtn") as HTMLButtonElement | null;
const aboutAppVersion = document.getElementById("aboutAppVersion") as HTMLElement | null;

async function initAboutModal() {
  if (aboutAppVersion) {
    try {
      const ver = await getVersion();
      if (ver) {
        aboutAppVersion.textContent = `v${ver}`;
      }
    } catch {
      aboutAppVersion.textContent = "v1.0.0";
    }
  }

  function openAbout() {
    if (!aboutModal) return;
    aboutModal.style.display = "flex";
    aboutOkBtn?.focus();
  }

  function closeAbout() {
    if (!aboutModal) return;
    aboutModal.style.display = "none";
    aboutBtn?.focus();
  }

  aboutBtn?.addEventListener("click", openAbout);
  closeAboutModalBtn?.addEventListener("click", closeAbout);
  aboutOkBtn?.addEventListener("click", closeAbout);

  aboutModal?.addEventListener("click", (e) => {
    if (e.target === aboutModal) {
      closeAbout();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && aboutModal && aboutModal.style.display !== "none") {
      closeAbout();
    }
  });
}

initAboutModal();

