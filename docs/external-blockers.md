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

**System audio is implemented on macOS.** `AudioCaptureSession` opens a second, independent
ScreenCaptureKit `SCStream` (audio-only, 2×2 surface, current-process audio excluded) and
writes `audio-system.wav` at 16 kHz mono beside the microphone archive. The stop path
persists both paths plus the tap's start offset, and transcription merges the two archives
on one timeline, labelling microphone segments `You` and loopback segments `Them`. The
opt-in `MEMO_SYSTEM_AUDIO_E2E=1` acceptance plays a real tone and asserts non-silence. On
the recorded host it skipped because Screen Recording was denied to the test process, so
the runtime path still needs that grant and a rerun.

**Windows is written but not run here.** The `wasapi` 0.27 loopback backend is compiled
only on Windows. `scripts/check-windows-backend.sh` type-checks and lints the module for
`x86_64-pc-windows-msvc` from macOS, so its API usage is verified; capture has not been run
on a Windows host in this environment, so runtime behaviour stays unverified.

**Known limits of the loopback path:**

- macOS requires the user's Screen Recording grant. Without it, start fails with an
  actionable message; the microphone take is rolled back and no phantom meeting remains.
- Echo cancellation is not applied. The microphone can pick up the speakers, so headphones
  are recommended. Channel labels describe the capture device, not voice identity.
- The system archive can legitimately be silent when nothing plays. That is reported as a
  fact (`system.silent`) rather than as invented transcript text.

**Still not implemented:**

- **Speaker diarization.** Channel labels are `You`/`Them`; no voiceprint embedding or
  clustering runs. The voiceprint columns and model registry entry exist but are unused.
- **iOS/Android capture.** `cpal` compiles for mobile targets, but microphone permission
  prompts, audio-session categories, and the Tauri mobile project are not wired or tested.
  The engine and WAV/ASR layers are portable Rust with no desktop-only dependency.
- **Streaming ASR.** Transcription intentionally runs after the take. Live caption deltas
  would require a streaming decoder and a second model state; the UI does not claim them.

**Unblock (diarization):** run the registry segmentation/embedding models after capture and
cluster into `speakers`, keeping all inference local.

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

**Partially blocked.** `pnpm package:release` builds and stages the platform installers,
verifies the macOS bundle signature and audio-input entitlement, and writes SHA-256
checksums plus `release-manifest.json`. `tauri.conf.json` pins `signingIdentity: "-"` so
local builds are valid ad-hoc, hardened-runtime bundles; `APPLE_SIGNING_IDENTITY`
overrides it for Developer ID builds. `createUpdaterArtifacts` remains false by design,
so updates are manual, checksum-verified installer replacements.

**Blocked on this host:** notarization. The only installed certificate is
`Apple Development`, not `Developer ID Application`, and no `APPLE_ID`/`APPLE_PASSWORD`/
`APPLE_TEAM_ID` or App Store Connect API key is available. The DMG is therefore
Gatekeeper-rejected until a deploying organization signs and notarizes it. The CI
workflow is committed but was not executed here; Windows runtime behavior is still
unverified.

**Unblock:** install a Developer ID Application certificate and Apple notarization
credentials, then run `pnpm package:release -- --require-signature --require-notarization`.
See [packaging.md](./packaging.md).

## Deep-link routing

The `tauri-plugin-deep-link` plugin is initialized and the scheme is generated from the
brand manifest, so the configuration is valid. No frontend route currently handles an
incoming URL. Add a listener and a navigation policy if deep links become a product
feature.

## Related documents

- [Acceptance and verification](./acceptance.md)
- [Packaging and release](./packaging.md)
- [Architecture](./architecture.md)
- [Upstream harvest](./upstream-harvest.md)
