# External blockers and follow-ups

These items are intentionally not claimed as complete. Each entry states what exists, what
is missing, and what would unblock it.

## M1.7 — Full upstream Meetily baseline

**Blocked.** The upstream v0.4.1 checkout cannot produce a debug bundle in this workspace:

- Tauri `externalBin` requires `binaries/llama-helper-aarch64-apple-darwin`, which upstream
  does not ship and has no build script for.
- Upstream `build.rs` downloads FFmpeg (22,400,365 bytes) and, on Windows, ONNX Runtime at
  build time. That is incompatible with a reproducible offline build unless the artifacts
  are vendored and checksummed.
- Rust, CMake, protoc, and FFmpeg are installed; Bazel is not.

This repository does not vendor the upstream application. It keeps the read-only analysis
in [upstream-harvest.md](./upstream-harvest.md) and builds its own host instead.

**Unblock:** build the helper on a connected host, vendor it with a checksum, or replace the
helper path with the app's own audio worker. Then record the exact command and artifact
hashes.

## M5.4 — Native LiteRT-LM worker compilation

**Blocked.** The following is committed and tested:

- C++20 `OmniEngine` / `OmniSession` worker source.
- 4-byte big-endian length + UTF-8 JSON protocol, 16 MiB cap, request IDs, token streaming,
  shutdown, typed errors.
- Rust `WorkerClient` with spawn, hello, load, generate, timeout, and frame-limit tests.
- CMake and Bazel build scaffolds plus protocol documentation.
- Lazy spawn and fail-closed `UnavailableEngine` selection in the host.

Compiling against upstream `google-ai-edge/LiteRT-LM` needs Bazel and a multi-GB native
tree; that build was not run here. The Rust side is tested against fake workers, not the
real C++ ABI.

**Unblock:**

```bash
cmake -S crates/memo-litert-bridge/cpp -B /tmp/memo-litert-worker-build
cmake --build /tmp/memo-litert-worker-build
```

with LiteRT-LM installed, then place `memo-litert-worker` next to the app binary or set
`MEMO_LITERT_WORKER`. Verify `hello` → `load` → `generate` with a small model.

## Model weights and digests

**Weights are not vendored.** Every shipped catalog artifact now carries a mandatory
SHA-256 from the publisher; an unpinned download is not representable in the type system.

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| Whisper small q5_1 (`ggml-small-q5_1.bin`) | 190,085,487 B | `ae85e4a9…11bb` |
| Whisper tiny q5_1 (`ggml-tiny-q5_1.bin`) | 32,152,673 B | `81871056…c3d7` |
| Gemma 4 E2B IT (`gemma-4-E2B-it.litertlm`) | 2,588,147,712 B | `18193810…a63c` |
| Gemma 4 E4B IT (`gemma-4-E4B-it.litertlm`) | 3,659,530,240 B | `0b2a8980…52e0` |

The downloader enforces declared size, resumes partial files, computes SHA-256, and deletes
the partial file on any mismatch. Digests were read from the Hugging Face API and the
Whisper small file was downloaded and re-hashed on the recorded host.

**Remaining:** weights stay out of git and must be provisioned on first run. A production
release still needs a mirror/offline-bundle decision for air-gapped deployments.

## Audio capture and transcription

**Microphone path works.** `memo-audio-capture` binds `cpal` to the platform audio
framework, downmixes to mono, feeds the clean-room mixer at 48 kHz, and archives 16 kHz mono
WAV while the meeting runs. `stop_recording` finalizes the header, persists the path, and
reports silence/overrun facts. `transcribe_meeting` decodes the archive in 30-second blocks,
skips silent blocks, runs whisper.cpp, and replaces `transcript_segments` in one
transaction. The real-model acceptance test transcribes known speech with timestamps.

**Not implemented:**

- **System audio (ScreenCaptureKit/Core Audio tap).** The dialog shows a disabled
  "Planned" toggle and tells the user to use the microphone or a second device. No loopback
  samples are captured or claimed.
- **Speaker diarization.** Every microphone segment is labelled `You`; no voiceprint
  embedding or clustering runs. The voiceprint columns and model registry entry exist but
  are unused.
- **iOS/Android capture.** `cpal` compiles for mobile targets, but microphone permission
  prompts, audio-session categories, and the Tauri mobile project are not wired or tested.
  The engine and WAV/ASR layers are portable Rust with no desktop-only dependency.
- **Streaming ASR.** Transcription intentionally runs after the take. Live caption deltas
  would require a streaming decoder and a second model state; the UI does not claim them.

**Unblock (system audio):** add a ScreenCaptureKit audio-only tap on macOS and WASAPI
loopback on Windows behind `AudioSource::System`, feed the existing mixer, and tag segments
`system`. **Unblock (diarization):** run the registry segmentation/embedding models after
capture and cluster into `speakers`. Both must stay local.

## Cross-platform screenshot capture

**Partial.** macOS uses `/usr/sbin/screencapture` and inherits the Screen Recording
permission. Windows and Linux return a typed "not implemented" error. Tests and the demo
harness use the synthetic backend via `MEMO_SYNTHETIC_CAPTURE=1`.

**Unblock:** add Windows Graphics Capture and a Linux PipeWire/portal backend behind the
same `ScreenCapture` trait, with the existing dHash/dedup path unchanged.

## Slide OCR

**Contract only.** `screenshots.ocr_extracted_text` is indexed by FTS5 and
`update_screenshot_ocr` persists results, but no OCR/vision engine runs.

**Unblock:** run on-device OCR/vision over accepted frames and feed the text into the
existing column. It must remain local and use the existing evidence rules.

## Distribution and release

**Out of scope.** The bundle is unsigned, not notarized, has no updater artifacts, and has
no CI packaging. `createUpdaterArtifacts` is false. Signing identities, hardened runtime
settings, and release channels must be supplied by the deploying organization.

## Deep-link routing

The `tauri-plugin-deep-link` plugin is initialized and the scheme is generated from the
brand manifest, so the configuration is valid. No frontend route currently handles an
incoming URL. Add a listener and a navigation policy if deep links become a product
feature.

## Related documents

- [Acceptance and verification](./acceptance.md)
- [Architecture](./architecture.md)
- [Upstream harvest](./upstream-harvest.md)
