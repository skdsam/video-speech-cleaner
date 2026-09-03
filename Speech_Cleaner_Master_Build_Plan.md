# Speech Cleaner — Master Build Plan

## 1. Project Goal

Build a self contained Windows desktop application that detects filler words such as:

- um
- umm
- uh
- uhh
- erm
- err
- er

The application must work completely offline and must not require:

- paid APIs
- cloud services
- accounts
- subscriptions
- API keys
- Python
- external software installation
- internet access after installation

The application must not cut or shorten the video.

Instead, it should detect filler words in the audio and mute only those exact audio regions to 0 volume while keeping the full audio duration unchanged.

This guarantees that the audio remains synchronised with the original video.

---

# 2. Core Product Principle

The video stream must remain untouched.

The audio stream is analysed and edited.

Example:

```text
Original speech:

"Today, um, we're going to look at Blender."

Detected filler:

um
Start: 5.20 sec
End:   5.57 sec

Cleaned speech:

"Today, [silence], we're going to look at Blender."
```

The audio length does not change.

The video length does not change.

The video frames do not change.

Only the gain for the detected filler region is reduced to silence.

---

# 3. Core Technology Stack

## Desktop Application

Use:

- Tauri 2
- Rust
- HTML
- CSS
- TypeScript

Avoid:

- Electron
- Python
- web servers
- cloud backends

## Speech Recognition

Use:

- whisper.cpp
- bundled local Whisper model

The speech engine must run locally.

The model file must ship with the application.

Initial model testing should compare:

- tiny.en
- base.en
- small.en

Start development with:

```text
base.en
```

## Media Processing

Use:

- FFmpeg
- FFprobe

Both should ship with the application.

The end user should never need to install them separately.

---

# 4. Application Architecture

```text
Speech Cleaner
│
├── Tauri Frontend
│   ├── HTML
│   ├── CSS
│   ├── TypeScript
│   ├── File Import
│   ├── Waveform UI
│   ├── Detection Review
│   ├── Preview
│   └── Settings
│
├── Rust Core
│   ├── Project Manager
│   ├── Media Inspector
│   ├── Audio Extractor
│   ├── Whisper Manager
│   ├── Detection Engine
│   ├── Preview Manager
│   ├── Mute Region Manager
│   ├── Export Manager
│   └── Settings Manager
│
├── Bundled Binaries
│   ├── whisper.cpp
│   ├── FFmpeg
│   └── FFprobe
│
├── Bundled AI Models
│   └── Whisper English model
│
└── User Data
    ├── Preferences
    ├── Project Files
    ├── Cache
    └── Temporary Analysis Files
```

---

# 5. Version 1 Scope

Version 1 should support:

## Input

Video:

- MP4
- MOV
- MKV
- AVI
- WEBM

Audio:

- WAV
- MP3
- AAC
- FLAC
- M4A

## Detection

Detect:

- um
- umm
- uh
- uhh
- erm
- err
- er

## Editing

For each detected filler:

- retain original timeline duration
- reduce volume to 0
- apply short fade before mute
- apply short fade after mute
- allow the user to enable or disable each detection
- allow manual adjustment of start and end time

## Output

Export:

- cleaned video
- cleaned audio

For video:

- copy original video stream without reencoding
- process only the audio stream

---

# 6. Development Order

The project should be built in the following order.

Do not begin with a large user interface.

First prove that the core detection and audio processing system works.

---

# 7. Milestone 1 — Command Line Proof

The first prototype should perform this complete pipeline:

```text
Input MP4
   ↓
Inspect with FFprobe
   ↓
Extract temporary WAV
   ↓
Run whisper.cpp
   ↓
Parse speech timestamps
   ↓
Find filler words
   ↓
Create mute ranges
   ↓
Process original audio
   ↓
Copy video stream
   ↓
Export cleaned MP4
```

The first milestone is successful when:

1. A test video can be supplied.
2. The application extracts its speech audio.
3. Whisper detects the filler words.
4. Accurate timestamps are returned.
5. Those regions are muted.
6. The audio remains exactly the same duration.
7. The video stream is copied unchanged.
8. The cleaned video remains perfectly synchronised.

---

# 8. Test Asset

Use the supplied test file:

```text
Speech_Cleaner_Test.mp4
```

Ground truth file:

```text
Speech_Cleaner_Test_Ground_Truth.json
```

The video contains five deliberate filler words:

```text
um
err
erm
uh
umm
```

Expected approximate positions:

```text
um     4.436 sec
err   10.007 sec
erm   15.188 sec
uh    21.372 sec
umm   26.511 sec
```

These known values should be used to test detection accuracy.

---

# 9. Milestone 1A — Media Inspection

Use FFprobe to inspect the source file.

Collect:

```text
container format
duration
video codec
audio codec
resolution
frame rate
number of video streams
number of audio streams
sample rate
channel count
audio bitrate
```

Store this in a Rust structure.

Example:

```rust
struct MediaInfo {
    duration: f64,
    video_codec: String,
    audio_codec: String,
    width: u32,
    height: u32,
    audio_streams: Vec<AudioStreamInfo>,
}
```

The application must handle files with multiple audio streams.

---

# 10. Milestone 1B — Extract Analysis Audio

Whisper does not need the original full quality audio.

Create a temporary analysis WAV using FFmpeg.

Target analysis format:

```text
16 kHz
Mono
PCM
```

Pipeline:

```text
Input video/audio
      ↓
FFmpeg
      ↓
analysis.wav
```

The original file must remain untouched.

Temporary files should be stored inside the application cache directory.

---

# 11. Milestone 1C — Integrate whisper.cpp

Initially use whisper.cpp as a bundled sidecar executable.

Rust launches whisper.cpp and receives structured output.

Required Whisper output:

- recognised text
- word-level and token-level timestamps (critical for pinpoint filler boundaries; requires `--output-json-full` / `--max-len 1` or word timestamp flags in `whisper-cli`)
- confidence where available

Prefer JSON or another structured output format.

Do not parse human readable console output unless absolutely necessary.

Later versions may replace the sidecar process with direct library integration.

Initial structure:

```text
Tauri
  ↓
Rust
  ↓
whisper.cpp executable
```

Future structure:

```text
Tauri
  ↓
Rust
  ↓
whisper.cpp library
```

---

# 12. Milestone 1D — Normalise Recognised Words

Before filler comparison:

- convert text to lowercase
- trim whitespace
- remove punctuation around tokens
- normalise obvious elongated forms where appropriate

Examples:

```text
"Um,"  → "um"
"ERR!" → "err"
"erm." → "erm"
```

Do not match filler sounds inside normal words.

Never match:

```text
umbrella
urban
urgent
earth
under
```

Only complete recognised tokens should qualify.

---

# 13. Milestone 1E — Detection Structure

Each filler detection should contain:

```rust
struct FillerDetection {
    id: String,
    word: String,
    start: f64,
    end: f64,
    confidence: f32,
    enabled: bool,
}
```

Example:

```json
{
  "word": "um",
  "start": 5.20,
  "end": 5.57,
  "confidence": 0.93,
  "enabled": true
}
```

---

# 14. Milestone 1F — Detection Rules

Initial filler dictionary:

```text
um
umm
uh
uhh
erm
err
er
```

Support configurable filler words later.

Detection should use confidence thresholds.

Suggested starting values:

```text
High confidence
85% or higher
Automatically selected

Medium confidence
60% to 85%
Show for review

Low confidence
Below 60%
Ignore by default
```

These values must be tested and adjusted using real recordings.

---

# 15. Milestone 1G — Timestamp Padding

Speech recognition timestamps may not perfectly include the full sound.

Add configurable padding.

Suggested default:

```text
Before: 30 ms
After:  30 ms
```

Example:

```text
Detected

5.20 → 5.57

Actual mute

5.17 → 5.60
```

Clamp all mute ranges to valid media duration.

---

# 16. Milestone 1H — Smooth Mute Transitions

Do not apply instant gain changes.

Hard transitions may cause clicks.

Use short fades.

Suggested default:

```text
Fade out: 8 ms
Fade in:  8 ms
```

Concept:

```text
100%
  \
   \
    0%────────────0%
                   /
                  /
               100%
```

The filler itself should reach complete silence.

---

# 17. Milestone 1I — Audio Processing

The audio timeline must never be shortened.

The processing engine should apply gain automation.

Conceptually:

```text
Normal audio:
gain = 1.0

Detected filler:
gain = 0.0
```

Multiple mute ranges should be supported.

Example:

```text
4.40 → 4.75
10.00 → 10.32
15.18 → 15.62
21.37 → 21.70
26.51 → 26.95
```

All these regions should be applied in one export operation where possible.

### Implementation Filtergraph:
In FFmpeg, multiple mute intervals with smooth fades can be cleanly constructed in a single pass without quality loss or drift:
- Using `volume=enable='between(t, START, END)':volume=0:eval=frame` chained or combined via boolean OR in evaluation, OR
- Using chained `volume=eval=frame:volume='if(between(t, s, e), 0, 1)'` with linear ramp expressions for fades:
  `volume='if(between(t, s-f, s), (s-t)/f, if(between(t, s, e), 0, if(between(t, e, e+f), (t-e)/f, 1)))':eval=frame`
- Alternatively chaining discrete `afade=t=out:st=...:d=...` and `afade=t=in:st=...:d=...` for smaller numbers of ranges.

---

# 18. Milestone 1J — Video Export

For video files:

```text
Video stream
     ↓
COPY UNCHANGED

Audio stream
     ↓
Decode
     ↓
Apply mute automation
     ↓
Encode audio
```

The final container receives:

```text
Original video stream
+
Cleaned audio stream
```

Avoid video reencoding.

Benefits:

- no video quality loss
- faster export
- lower CPU usage
- same resolution
- same frame rate
- original video bitrate preserved

---

# 19. Milestone 1K — Validate Sync

Every test export must verify:

```text
Input duration
Output duration
Audio duration
Video duration
```

The difference should be negligible and within container timing tolerances.

Also verify visually and audibly that:

- speech remains aligned with mouth movement
- video frames remain unchanged
- filler regions are muted
- surrounding words are not clipped

---

# 20. Milestone 2 — Tauri Desktop Interface

Once Milestone 1 works reliably, build the desktop UI.

Initial screen:

```text
┌───────────────────────────────────────────────┐
│ Speech Cleaner                               │
├───────────────────────────────────────────────┤
│                                               │
│     Drop a video or audio file here           │
│                                               │
│               [ Select File ]                 │
│                                               │
└───────────────────────────────────────────────┘
```

Support:

- drag and drop
- standard file picker

---

# 21. Imported Media Screen

Show:

```text
File name
Duration
Resolution
Video codec
Audio codec
Audio streams
Sample rate
```

Example:

```text
MyRecording.mp4

Duration       18:42
Resolution     3840 × 2160
Video          H.264
Audio          AAC Stereo
Sample Rate    48 kHz

Audio Track
● Track 1

[ Analyse Speech ]
```

---

# 22. Analysis Progress

Show clear stages:

```text
Preparing audio
Analysing speech
Detecting filler words
Preparing results
```

Show percentage where possible.

Allow cancellation.

Clean up temporary files if cancelled.

---

# 23. Detection Review Screen

After analysis:

```text
Detected Fillers: 43

✓ 00:12.430   UM    0.31 sec   94%   ▶
✓ 00:27.170   UH    0.24 sec   91%   ▶
✓ 00:38.910   UM    0.42 sec   87%   ▶
✓ 01:04.120   ERM   0.58 sec   83%   ▶
```

Each result needs:

- checkbox
- timestamp
- word
- duration
- confidence
- preview button

Add:

```text
Select All
Deselect All
Select High Confidence
```

---

# 24. Preview

Each filler should be previewable in context.

Suggested preview range:

```text
2 seconds before
detected filler
2 seconds after
```

Allow:

```text
Original
Cleaned
```

The user should be able to hear the difference instantly.

---

# 25. Waveform

Add a waveform once the basic list interface works.

Display:

```text
              UM
               ↓

   ▄  ▅▄      ██       ▃▅▇▄
▄▆██████▄____████_____████████▄
────────────────────────────────
```

Detected filler regions should be visibly marked.

The user should be able to:

- select a detection
- drag the start boundary
- drag the end boundary
- preview the adjusted region

---

# 26. Manual Mute Regions

Support manual editing.

The user selects a waveform range and presses:

```text
Mute
```

Keyboard shortcut suggestion:

```text
M       Create mute region
Delete  Remove selected mute region
Space   Play or pause
```

This allows cleaning things the AI misses.

---

# 27. Non Destructive Project Model

Never alter the source file.

Create a project containing:

```text
source file path
media information
transcript
detections
mute regions
settings
AI model information
```

Mute structure:

```json
{
  "start": 12.430,
  "end": 12.780,
  "fade_in": 0.008,
  "fade_out": 0.008,
  "enabled": true
}
```

---

# 28. Project Files

Suggested extension:

```text
.sclean
```

Example:

```text
MyRecording.sclean
```

The file should be JSON based initially.

Store:

```text
project version
source path
source hash if practical
duration
transcription
detections
manual mute regions
settings
model version
```

Reopening the project should not require speech analysis again.

---

# 29. Settings

Basic settings:

```text
AI Model
● Fast
○ Accurate

Language
English

Filler Words
☑ Um
☑ Uh
☑ Erm
☑ Er
☐ Hmm
☐ Ah

Padding Before
30 ms

Padding After
30 ms

Fade
8 ms

Detection
Balanced

Output Folder
Same folder as source
```

Advanced settings:

```text
CPU thread count
GPU acceleration
Model path
Confidence threshold
Temporary directory
Audio codec
Audio bitrate
```

---

# 30. Detection Presets

Suggested presets:

## Conservative

Use only high confidence detections.

Goal:

Minimise false positives.

## Balanced

Default mode.

Good mix of detection and safety.

## Aggressive

Show lower confidence detections.

Goal:

Find as many filler words as possible.

---

# 31. GPU Acceleration

CPU mode must always work.

GPU support should be optional.

Detect available hardware where supported.

Possible statuses:

```text
NVIDIA GPU detected
AMD GPU detected
Intel GPU detected
CPU only
```

Never require a discrete GPU.

The product promise should remain:

```text
Install it and it works.
```

---

# 32. Bundling

The installer should include:

```text
Speech Cleaner application
whisper.cpp
Whisper model
FFmpeg
FFprobe
required runtime files
open source licence notices
```

No dependency should need a separate download after installation.

---

# 33. Licensing

Before public distribution, confirm licences for:

- Tauri
- Rust crates
- whisper.cpp
- Whisper model
- FFmpeg
- any waveform library
- any icons or fonts

FFmpeg build configuration must be selected carefully because enabled codecs and libraries can affect licensing requirements.

Keep an:

```text
Open Source Licences
```

screen inside the application.

---

# 34. Temporary Files

Suggested location:

```text
AppData
└── SpeechCleaner
    ├── cache
    ├── projects
    └── temp
```

Temporary analysis WAV files should be deleted after use unless still required by an open project.

On application launch:

- detect abandoned temporary files
- clean stale files safely

---

# 35. Error Handling

Handle at least:

```text
unsupported file
file cannot be opened
no audio stream
corrupt media
FFmpeg failure
FFprobe failure
Whisper failure
model missing
insufficient disk space
export path not writable
cancelled analysis
cancelled export
source moved after project save
```

Errors should be shown in plain language.

Also keep technical logs for debugging.

---

# 36. Testing Strategy

Create a dedicated test suite.

Start with the provided synthetic test video.

Then build a real world speech library.

Suggested categories:

```text
British English
American English
Scottish accents
Welsh accents
Irish accents
quiet speech
fast speech
slow speech
studio microphones
cheap microphones
headsets
room echo
computer fans
background noise
background music
multiple filler words
long ums
short uhs
false starts
```

---

# 37. Detection Metrics

For every test clip record:

```text
Actual fillers
Correct detections
Missed fillers
False detections
Timestamp start error
Timestamp end error
```

Calculate:

```text
Precision
Recall
False Positive Rate
Average Timestamp Error
```

Do not choose the model based only on transcription quality.

Choose based on filler detection performance.

---

# 38. Automated Test Against Ground Truth

For the supplied test video:

Expected:

```text
um     4.436
err   10.007
erm   15.188
uh    21.372
umm   26.511
```

Create an automated test that:

1. Runs the speech analyser.
2. Reads the detected filler list.
3. Compares each detected filler with the ground truth JSON.
4. Measures timestamp difference.
5. Reports pass or fail.

Suggested initial tolerance:

```text
±250 ms
```

Then reduce this target as accuracy improves.

---

# 39. Audio Quality Tests

For every mute:

Check:

- no audible click at mute start
- no audible click at mute end
- word before filler remains intact
- word after filler remains intact
- no unexpected gain change outside mute region
- no drift in audio timing

---

# 40. Export Tests

Test:

```text
MP4 H.264 + AAC
MP4 H.265 + AAC
MOV
MKV
WEBM
```

Verify:

- container opens
- video stream copied successfully
- cleaned audio plays
- duration correct
- sync correct

Fallback behaviour may be required if a container cannot accept the requested copied video and encoded audio combination.

---

# 41. Version 1 Release Requirements

Version 1 is ready when all of the following work reliably:

```text
✓ Windows desktop application
✓ Self contained installer
✓ Completely offline
✓ No account
✓ No API
✓ No subscription
✓ No cloud upload
✓ Video input
✓ Audio input
✓ Local speech recognition
✓ Um detection
✓ Uh detection
✓ Erm detection
✓ Er detection
✓ Accurate timestamps
✓ Detection review list
✓ Preview each filler
✓ Enable or disable each detection
✓ Adjustable padding
✓ Smooth mute fades
✓ Waveform
✓ Manual mute regions
✓ Original source remains untouched
✓ Video stream copied without reencoding
✓ Only audio processed
✓ Export cleaned video
✓ Export cleaned audio
✓ Save and load projects
✓ Temporary file cleanup
✓ Error handling
```

---

# 42. Future Features

Do not build these before version 1 is stable.

Possible later features:

```text
breath reduction
mouth click detection
cough detection
long silence detection
false start detection
repeated word detection
stutter detection
background hum reduction
room tone replacement
batch processing
folder processing
custom filler dictionaries
multiple language models
multiple audio track cleaning
original and cleaned tracks in same video
export markers
subtitle export
transcript editor
timeline integration
```

---

# 43. Possible Future Cleaning Modes

Version 1:

```text
Mute
```

Future:

```text
Room Tone
Attenuate
Noise Fill
Smart Reconstruction
```

Mute remains the safest and simplest initial option.

---

# 44. Suggested Repository Structure

```text
speech-cleaner/
│
├── README.md
├── LICENSES/
│
├── src/
│   ├── components/
│   ├── pages/
│   ├── services/
│   ├── styles/
│   └── main.ts
│
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── media.rs
│   │   ├── ffmpeg.rs
│   │   ├── whisper.rs
│   │   ├── detection.rs
│   │   ├── mute.rs
│   │   ├── export.rs
│   │   ├── project.rs
│   │   └── settings.rs
│   │
│   ├── binaries/
│   │   ├── ffmpeg.exe
│   │   ├── ffprobe.exe
│   │   └── whisper-cli.exe
│   │
│   ├── models/
│   │   └── whisper-model.bin
│   │
│   └── tauri.conf.json
│
├── tests/
│   ├── media/
│   │   ├── Speech_Cleaner_Test.mp4
│   │   └── Speech_Cleaner_Test_Ground_Truth.json
│   │
│   ├── detection/
│   ├── export/
│   └── audio/
│
└── docs/
    ├── architecture.md
    ├── testing.md
    └── licences.md
```

---

# 45. Recommended Development Sequence

Follow this order.

## Stage 1

Create Rust command line test program.

## Stage 2

Call FFprobe and read source metadata.

## Stage 3

Extract mono 16 kHz WAV.

## Stage 4

Run whisper.cpp.

## Stage 5

Parse recognised words and timestamps.

## Stage 6

Detect filler tokens.

## Stage 7

Compare detections against ground truth JSON.

## Stage 8

Generate mute ranges.

## Stage 9

Apply mute automation with FFmpeg.

## Stage 10

Remux cleaned audio with copied video.

## Stage 11

Validate duration and synchronisation.

## Stage 12

Add automated tests.

## Stage 13

Create Tauri shell.

## Stage 14

Add file selection and drag and drop.

## Stage 15

Add analysis progress.

## Stage 16

Add filler review list.

## Stage 17

Add playback preview.

## Stage 18

Add waveform.

## Stage 19

Add manual range editing.

## Stage 20

Add export UI.

## Stage 21

Add project saving.

## Stage 22

Add settings.

## Stage 23

Bundle binaries and AI model.

## Stage 24

Create installer.

## Stage 25

Run real world test library.

## Stage 26

Perform licensing review.

## Stage 27

Prepare version 1 release.

---

# 46. Definition of Core Success

Before spending significant time on interface design, the following test must pass:

```text
Speech_Cleaner_Test.mp4
        ↓
Local speech analysis
        ↓
Detect all expected filler words
        ↓
Return accurate timestamps
        ↓
Mute those regions
        ↓
Copy original video stream
        ↓
Create cleaned output
```

The output must satisfy:

```text
same video length
same frame count
same video stream quality
same timing
cleaned audio
no filler speech in muted regions
no clicks
no sync drift
```

If this works reliably, the underlying product concept is proven.

---

# 47. Guiding Principles

Throughout development:

1. Keep everything local.
2. Keep the application self contained.
3. Never alter the original file.
4. Never shorten the audio timeline.
5. Never reencode video unless absolutely unavoidable.
6. Process only the selected audio stream.
7. Give the user control over every AI suggestion.
8. Keep AI detection separate from audio editing.
9. Benchmark against known ground truth.
10. Build reliability before adding more features.

---

# 48. Immediate Next Task

The next development task is:

```text
Build the command line proof.
```

It should accept:

```text
Speech_Cleaner_Test.mp4
```

Then:

1. inspect it with FFprobe
2. extract analysis audio
3. analyse it with whisper.cpp
4. detect the five expected filler words
5. print their timestamps
6. compare them with the ground truth JSON
7. mute the detected regions
8. export a cleaned MP4
9. confirm the video stream was copied
10. confirm the output duration matches the input

Only after this succeeds should the main Tauri interface be built.

---

# 49. Milestone 3: Professional Workstation Polish, Synchronised Video & Deep Zoom Engine

## 49.1 High-Resolution Multi-Scale Audio Zoom Engine
For media spanning from 30 seconds to over an hour:
- An overview minimap timeline providing full file context and draggable viewport window.
- Detail waveform view equipped with continuous zoom (`Ctrl + MouseWheel` / Zoom Slider / Zoom In/Out buttons) scaling from 1x (whole project) up to 50x (sub-100ms granularity).
- Horizontal panning (`Shift + MouseWheel` or scrollbar) to navigate large timelines effortlessly.
- Exact time ruler with adaptive tick intervals (hours, minutes, seconds, milliseconds).
- Authentic peak-derived amplitude rendering extracted during audio inspection.

## 49.2 Synchronised Expandable Video Preview Player
- Collapsible/expandable video monitor dockable alongside or above the timeline.
- Bi-directional scrubbing synchronization: moving the timeline playhead scrubs the video frame instantly, and playing the video moves the audio playhead.
- Compact / Expanded toggle with native video aspect ratio preservation.

## 49.3 Native Desktop Workstation Design Contract
- Clean, crisp, solid workstation aesthetic inspired by professional NLEs (DaVinci Resolve, Premiere Pro, Audacity).
- No glassmorphic blur filters, no fuzzy neon drop-shadows, no AI-gimmick styling.
- High-contrast, utilitarian dark palette (`#111318`, `#161920`, `#1C2029`, `#262C38`), crisp 1px borders, compact padding, and professional `Inter` / `JetBrains Mono` typography.
- Clear tactile feedback on hover, selection, and toggle states.
- Author credit: SkdSam.
