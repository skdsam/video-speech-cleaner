# Video Speech Cleaner

**Author:** SkdSam  
**Repository:** [github.com/skdsam/video-speech-cleaner](https://github.com/skdsam/video-speech-cleaner)

A self-contained desktop application that automatically detects filler speech sounds (*um*, *umm*, *uh*, *uhh*, *erm*, *err*, *er*) in video and audio files using a local Whisper model, and mutes those exact regions without cutting, shortening, or re-encoding the video stream.

---

## Features
- **100% Offline & Private:** Uses local `whisper.cpp` and bundled GGML speech models. No cloud APIs, no subscriptions, no accounts.
- **Zero Video Degradation:** Video streams are copied 1:1 (`-c:v copy`), preserving full original frame rate, resolution, bitrate, and quality.
- **Perfect Audio-Video Synchronization:** Mutes exact filler intervals with configurable micro-fades (8 ms) and padding (30 ms) while maintaining the original timeline duration.
- **Audio Waveform & Mute Overlays:** Visualizes detected filler regions over audio waveforms.
- **Interactive Review:** Inspect confidence scores, preview snippets, and toggle any detection before export.

---

## Tech Stack
- **Desktop Framework:** Tauri 2 (Rust)
- **Frontend:** Vanilla TypeScript, Vite, CSS (Glassmorphism Dark Theme)
- **Package Manager:** `pnpm`
- **Speech Engine:** `whisper.cpp` + `ggml-small.en.bin` (preferred), with `ggml-base.en.bin` as a fallback
- **Media Engine:** FFmpeg & FFprobe

---

## Quick Start / Rebuilding the Application

### 1. Prerequisites
- **Rust & Cargo:** [Install Rust](https://rustup.rs/) (edition 2021+)
- **Node.js & pnpm:** [Node.js](https://nodejs.org/) (v20+) and `npm install -g pnpm`
- **FFmpeg & FFprobe:** Installed and added to system `PATH`

### 2. Setup Binaries & Model
1. Place `whisper-cli.exe` and its runtime DLLs in `binaries/Release/`:
   - Download from [whisper.cpp Releases](https://github.com/ggerganov/whisper.cpp/releases) (`whisper-bin-x64.zip`).
2. Install the preferred small English model (488 MB, verified SHA-256):
   ```powershell
   .\scripts\setup-model.ps1
   ```

   Existing installations with only `models/ggml-base.en.bin` still work. The small model improves filler recognition at the cost of longer analysis. Models run locally after installation.

### 3. Build & Run Desktop App
```powershell
cd speech-cleaner-app
pnpm install
pnpm tauri dev
```

To compile a release binary:
```powershell
pnpm tauri build --no-bundle
```
The executable is generated at:
`speech-cleaner-app/src-tauri/target/release/speech-cleaner-app.exe`

### 4. Running the CLI Verification Benchmark

To exercise the **same analysis pipeline as the desktop application**, without exporting or modifying the input:

```powershell
cd speech-cleaner-app/src-tauri
cargo test --lib
cargo test --test media_regression -- --ignored
cargo run --release --example analyze -- "C:\path\to\video.mp4" result.json
```

The JSON includes every filler candidate and its selected state. The recognizer uses examples of hesitant speech and carries that prompt throughout long recordings. Matching reassembles subword tokens, preserves repeated occurrences, and accepts elongated spellings such as `ummmm` and `errrr`. Timestamp refinement uses 10 ms audio frames, independently of the display waveform. Candidates with estimated timing remain unselected for manual review.

Review detections before export: a higher detection count does not establish recall or precision, and Whisper can still omit or misrecognize sounds. The supplied ground-truth fixture can check the five known fillers in `Speech_Cleaner_Test.mp4`; the longer recording requires human annotations to measure recall.

The original milestone CLI is also available below. It retains the original base-model settings; use the commands above to validate current desktop behavior:
```powershell
cd speech_cleaner_cli
cargo run
```

---

## License
MIT License. Created by **SkdSam**.
