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

**Blocked on download size and provenance.** Weights are multi-GB and not vendored:

| Artifact | Approx. size |
| --- | --- |
| Parakeet TDT 0.6B v3 | 615 MiB |
| Whisper Tiny fallback | 42 MiB |
| Speaker diarization + embedding | 20 MiB |
| Gemma 4 E2B IT | 2.6 GB |
| Gemma 4 E4B IT | 3.55 GB |

The downloader enforces the declared byte size, resumes partial files, computes SHA-256,
and rejects a mismatch when the registry provides a digest. The shipped catalog currently
has `sha256: null` for the large artifacts because the exact upstream files and digests
were not available offline. A production release must populate trusted digests; otherwise
integrity is limited to size and transport security.

**Unblock:** fetch the exact artifacts on a connected staging host, record their SHA-256
values in `model_registry.rs`, and add a test that rejects a real-artifact hash mismatch.
Keep the weights out of git.

## Live audio capture and ASR

**Not wired.** `crates/memo-audio-capture` contains the tested dual-stream DSP (ring
buffers, mixing, resampling, downmix, level metering) but no OS bindings. The Tauri
`start_recording` command currently owns session state and the screenshot scheduler, not an
audio pipeline. The UI renders the pinned demo transcript, and `audio:levels` /
`asr:segment-delta` are contracts without a producer.

**Unblock:** add Core Audio / WASAPI / ALSA adapters behind `AudioSource`, wire the mixer to
a WAV writer and streaming ASR, emit the two events, and persist segments through
`append_transcript`. Then replace the demo transcript with `list_transcript` data in the
studio.

## Cross-platform screenshot capture

**Partial.** macOS uses `/usr/sbin/screencapture` and inherits the Screen Recording
permission. Windows and Linux return a typed "not implemented" error. Tests and the demo
harness use the synthetic backend via `MEMO_SYNTHETIC_CAPTURE=1`.

**Unblock:** add Windows Graphics Capture and a Linux PipeWire/portal backend behind the
same `ScreenCapture` trait, with the existing dHash/dedup path unchanged.

## Slide OCR and diarization engines

**Contract only.** `screenshots.ocr_extracted_text` is indexed by FTS5 and
`update_screenshot_ocr` persists results, but no OCR/vision engine runs. Speaker voiceprint
columns and the diarization registry artifact exist, but no embedding or clustering engine
is wired.

**Unblock:** run on-device OCR/vision over accepted frames and feed the text into the
existing column; run diarization embeddings after capture and persist speaker centroids.
Both must remain local and use the existing evidence/verification rules.

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
