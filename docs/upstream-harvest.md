# Upstream Harvest — Meetily v0.4.1 (audio capture)

Read-only analysis for the white-label fork. No upstream file was modified.

## 0. Provenance

| Field | Value |
|---|---|
| Clone URL | `https://github.com/Zackriya-Solutions/meetily.git` |
| Revision | `a2cb62e827da7ef59f65064c97233efb2313878e` |
| Tag | `v0.4.1` (commit date 2026-09-10) |
| Checkout | `/private/var/folders/6v/h7s_44bx7dl6xw0dyf4rft_h0000gn/T/opencode/meetily-v0.4.1` |
| Method | source reading, `Cargo.lock` inspection, `cargo metadata` reproduced with `cargo 1.100.0` |
| Out of scope | Python `backend/`, summary/LLM code, UI |

## 1. Cargo graph and the `[patch.crates-io]` block

Workspace root `Cargo.toml` (18 lines) declares `members = ["frontend/src-tauri", "llama-helper"]`, `resolver = "2"`, `rust-version = "1.77"`, and **no `[patch]` section**.

The patch lives in the *member* manifest, `frontend/src-tauri/Cargo.toml:212-214`, verbatim:

```toml
[patch.crates-io]
cpal = { git = "https://github.com/RustAudio/cpal", rev = "51c3b43" }
esaxx-rs = { git = "https://github.com/thewh1teagle/esaxx-rs.git", branch = "feat/dynamic-msvc-link" }
```

Relevant declarations and locked versions:

| Crate | Manifest | Locked | Notes |
|---|---|---|---|
| `cpal` | `Cargo.toml:74` `"0.15.3"` | **0.15.3 registry**, checksum `873dab…` | fork NOT used |
| `rubato` | `:141` `"0.15.0"` | 0.15.0 (used); 0.16.2 is an orphan lock entry | resampling |
| `ringbuf` | `:142` `"0.4.8"` | 0.4.8 | macOS tap ring |
| `esaxx-rs` | `:137` `"0.1.10"` | **0.1.10 registry** | unused in code; fork NOT used |
| `cidre` | `:173` git rev `a9587fa`, features `["av"]` | 0.11.3 git `a9587fa` | macOS Core Audio taps |
| `whisper-rs` | `:179` (macOS) `0.13.2` +`metal`,`coreml` | 0.13.2 / sys 0.11.1 | ASR coupling |
| `ort` | `:107` `2.0.0-rc.10` | rc.10 | Parakeet + silero VAD |
| `tauri` | `:151` `2.6.2` | 2.6.2 | shell |

Fork facts: `RustAudio/cpal@51c3b43` is *"Fix macos non-default audio output (#946)"* (2025-02-16). crates.io 0.15.3 already contains WASAPI loopback (`src/host/wasapi/device.rs`, `AUDCLNT_STREAMFLAGS_LOOPBACK`), so the fork is only relevant to the macOS non-default-output path. The `esaxx-rs` fork branch **no longer exists** (`git ls-remote` and HTTPS both return 404); nothing in the crate tree references `esaxx`.

## 2. `src/audio/` inventory (real code)

Declared in `audio/mod.rs:1-120`. ~17.4k lines across `audio/*.rs`, plus ~3.1k in `audio/{capture,devices,transcription}/`.

| Path | Lines | Role |
|---|---|---|
| `audio/capture/core_audio.rs` | 445 | macOS Core Audio process tap + aggregate device + `HeapRb<f32>`; `CoreAudioCapture`, `CoreAudioStream`, `AudioContext`, `audio_proc`, `process_audio_data` |
| `audio/capture/system.rs` | 152 | thin `SystemAudioCapture` wrapper; non-macOS `bail!` |
| `audio/capture/backend_config.rs` | 225 | global `RwLock<AudioCaptureBackend>`; enum names ScreenCaptureKit but no SCK code |
| `audio/capture/microphone.rs` | 3 | placeholder only (`TODO`) |
| `audio/stream.rs` | 494 | `AudioStream`, `StreamBackend::{Cpal,CoreAudio}`, `AudioStreamManager`, sample-format dispatch |
| `audio/pipeline.rs` | 1116 | `AudioCapture` (DSP), `AudioMixerRingBuffer`, `ProfessionalAudioMixer`, `AudioPipeline` (VAD-driven), `AudioPipelineManager` |
| `audio/audio_processing.rs` | 739 | mono downmix, rubato `SincFixedIn`, `LoudnessNormalizer` (ebur128), `NoiseSuppressionProcessor` (nnnoiseless), `HighPassFilter` |
| `audio/ffmpeg_mixer.rs` | 513 | per-source adaptive buffering (`FFmpegAudioMixer`, `BufferStats`); no ffmpeg involved |
| `audio/vad.rs` | 779 | silero VAD via `ort`; 48k→16k; `SpeechSegment` |
| `audio/transcription/*` | 6 files | provider trait, Whisper + Parakeet providers, worker pool |
| `audio/recording_state.rs` | 417 | `Arc<Mutex>` session state, unbounded chunk sender |
| `audio/recording_manager.rs` | 630 | start/stop orchestration, macOS BT "wake" workaround |
| `audio/recording_commands.rs` | 1697 | 8 Tauri commands; events |
| `audio/recording_saver.rs` / `incremental_saver.rs` | 479 / 475 | WAV + checkpoints + transcript JSON |
| `audio/import.rs` / `retranscription.rs` / `decoder.rs` | 1323 / 1054 / 869 | offline/batch paths |
| `audio/device_detection.rs` / `device_monitor.rs` | 509 / 443 | Bluetooth name heuristics; 2–5 s polling hotplug |
| `audio/devices/*` | 8 files | enumeration, `AudioDevice`, platform modules |
| `audio/level_monitor.rs` / `simple_level_monitor.rs` | 12,214 / 2,925 B | real meter vs. **fake sine meter** |
| `audio/system_audio_commands.rs` | 152 | 6 system-audio commands (`#[command]`) |

Not compiled (orphaned): `audio/core-old.rs`, `audio/recording_saver_old.rs`, `audio/stt.rs`, `audio/system_audio_stream.rs`, `audio/recording_commands.rs.backup`.

### `src/audio_v2/` — dead code

9 files / 1,393 lines (`stream.rs`, `mixer.rs`, `recorder.rs`, `resampler.rs`, `sync.rs`, `limiter.rs`, `normalizer.rs`, `compatibility.rs`, `lib.rs`). **It is not declared in `src/lib.rs`** (`lib.rs:40` declares only `audio`) and `audio_v2/stream.rs:16` imports `crate::audio::core`, a module that does not exist (`core.rs` is absent; only `core-old.rs`). It cannot compile; `resampler.rs`, `sync.rs`, `limiter.rs`, `normalizer.rs` are `TODO` stubs. Treat as design notes, never as source.

## 3. Dual-stream capture flow

Two independent producers, both delivering 48 kHz mono `f32` into one unbounded tokio channel.

1. **Microphone (all platforms, CPAL)** — `devices/configuration.rs:111` `get_device_and_config()` picks `default_input_config()`; `stream.rs:105-141` builds the input stream; `stream.rs:236-312` dispatches on `SampleFormat` (F32/I16/I32/I8 only). Callback calls `AudioCapture::process_audio_data` (`pipeline.rs:399`): downmix (`audio_to_mono`, averaged, first ≤2 channels, `audio_processing.rs:478`), persistent rubato resample to 48 kHz with a 512-sample staging buffer and `SincFixedIn` (`pipeline.rs:331-366`), then 80 Hz high-pass → RNNoise (compiled **off**: `ffmpeg_mixer.rs:20`) → EBU R128 −23 LUFS (`pipeline.rs:528-583`). Chunk goes to `RecordingState::send_audio_chunk` (`pipeline.rs:637`).
2. **System audio (macOS)** — `capture/core_audio.rs:91` creates a **mono global process tap** (`TapDesc::with_mono_global_tap_excluding_processes`); `:124-145` builds a private, stacked, auto-start aggregate device containing **only the tap** (comment documents that adding the output sub-device caused double audio); `:158-201` IO proc reads `AudioPcmBuf`; `:300-332` pushes samples into `HeapRb::<f32>::new(131_072)` (512 KiB, not "128KB" as commented) and wakes a `Waker`; `:343-372` exposes `Stream<Item = f32>` **one sample per poll**. `stream.rs:145-234` spawns a tokio task that re-batches 1,024 samples and feeds the same `AudioCapture` (channels forced to `1`).
3. **Windows/Linux system audio** — no dedicated module; `stream.rs` treats the output/monitor device as a CPAL *input* stream. Windows relies on cpal WASAPI loopback; Linux enumerates ALSA devices whose name contains `monitor` (`devices/platform/linux.rs:17-30`), which is unreliable on PipeWire/Pulse (cpal exposes no Pulse host).
4. **Mixing** — `AudioPipeline::run` (`pipeline.rs:842-906`): `AudioMixerRingBuffer` (`:31`) keeps two `VecDeque<f32>`; window = **600 ms** (`:41`, although the struct doc says 50 ms), max = 8 windows = 4.8 s (`:48`, comment says 400 ms). Windows are drained when either side has ≥1 window, the short side zero-padded; `ProfessionalAudioMixer::mix_window` (`:167`) sums with soft proportional limiting. **Chunk timestamps are ignored**; alignment is FIFO/arrival-order only.
5. **Fate of the mixed signal** — VAD segments (≥800 samples @16 kHz) go to the transcription channel (`:859-891`); the same mix goes to `RecordingSaver` for WAV (`:893-906`). Both sources are collapsed into `DeviceType::Microphone`, so speaker attribution is impossible downstream.
6. **Stop** — flush sentinel `chunk_id >= u64::MAX - 10` (`pipeline.rs:806-810`), VAD flush, stream pause+drop (`stream.rs:320-352`), WAV finalize.

**Commands** (all in `src-tauri/src/lib.rs` handler, `:612+`; 37 `#[command]`/`#[tauri::command]` functions under `audio/`): `start_recording`, `start_recording_with_devices[_and_meeting]`, `stop_recording`, `is_recording`, `pause_recording`, `resume_recording`, `is_recording_paused`, `get_recording_state`, `get_transcription_status`, `get_audio_devices`, `trigger_microphone_permission`, `start/stop/is_audio_level_monitoring`, `get/set_recording_preferences`, `get_default_recordings_folder_path`, `open/select_recordings_folder`, `get_available_audio_backends`, `get/set_audio_backend`, `get_audio_backend_info`, `get_transcript_history`, `get_recording_meeting_name`, `get_active_audio_output`, `recover_audio_from_checkpoints`, `cleanup_checkpoints`, `has_audio_checkpoints`, plus six `system_audio_commands` (`lib.rs:793-798`).

**Events**: `audio-levels`, `speech-detected`, `recording-starting`, `recording-started`, `recording-saved`, `recording-error`, `transcript-update`, `transcription-progress`, `transcription-queue-complete`, `transcription-warning`, `transcription-error`, `mic-unavailable`, `mic-device-switched`, `mic-swap-failed`, `system-audio-started`, `system-audio-stopped`.

## 4. Platform backends

| OS | Implementation | Path / key items |
|---|---|---|
| macOS | **Core Audio process tap** via `cidre` (not ScreenCaptureKit) | `audio/capture/core_audio.rs`; `CoreAudioCapture::new`, `stream()`, `audio_proc`, `AudioContext`; `audio/system_detector.rs`, `device_monitor.rs`, `device_detection.rs` also use `cidre::core_audio` |
| Windows | CPAL **WASAPI** host; output device used in loopback mode | `audio/devices/platform/windows.rs:8` `configure_windows_audio`, `:97` `get_windows_device`; loopback happens inside cpal |
| Linux | CPAL **ALSA**, "monitor" name filter; no PipeWire/Pulse API | `audio/devices/platform/linux.rs:7-32`; `devices/configuration.rs:157-172` |
| macOS "ScreenCaptureKit" | **label only** | `capture/backend_config.rs:11`, `stream.rs:18`; the only SCK API is a standalone permission-check script `check_screen_permission.swift` (not in the build) |

macOS minimum version: the process-tap API (`AudioHardwareCreateProcessTap`) and `NSAudioCaptureUsageDescription` require **macOS 14.4+** (comments at `core_audio.rs:60`, `permissions.rs:19`, `recording_preferences.rs:305`). `tauri.conf.json` sets **no `minimumSystemVersion`** (`bundle.macOS` is only `entitlements`, `signingIdentity: "-"`, `hardenedRuntime: true`, `:105-107`). Required plist keys are present in `Info.plist:5-12`: `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `NSAudioCaptureUsageDescription`, plus a misplaced `com.apple.security.device.audio-input` boolean (an entitlement key that does nothing in Info.plist). Entitlements (`entitlements.plist:5-12`) add audio-input, audio-output, microphone, screen-capture — but **app-sandbox is absent**, so those entitlement keys are inert.

## 5. Licensing

- Upstream license: **MIT**, `LICENSE.md:1-3` ("MIT License", "Copyright (c) 2024 Zackriya Solutions"); `frontend/src-tauri/Cargo.toml:6` `license = "MIT"`.
- No per-file SPDX or copyright headers anywhere under `src-tauri/src` (grep count = 0), no `NOTICE`/third-party file. Attribution must be repo-level.
- Verified dependency licenses for the reused path: `cpal` **Apache-2.0** (fork `Cargo.toml:7`), `cidre` **MIT** (`LICENSE.txt`), whisper.cpp submodule MIT, Tauri MIT/Apache-2.0.
- **MIT → GPL-3.0-or-later is compatible** (one-way relicensing; retain the MIT text and copyright, mark modifications). Apache-2.0 is also GPLv3-compatible. No copyleft conflict.
- Caveat: verbatim `KEEP` files make the result a **derivative fork**, not clean-room. A true clean-room would use this report + behavioral tests only. Decide explicitly; if copying, add `THIRD_PARTY_NOTICES.md` and SPDX headers.
- **Resolution (2026-11-14):** `LICENSE` now contains GPL-3.0-or-later text, matching
  `Cargo.toml`, `brand/brand.config.json`, and `generated_brand.rs`.
- **Decision: clean-room.** Upstream was read for behavior only. No upstream source file
  is vendored, so no MIT notice is carried for copied code. The audio crate is an
  independent DSP implementation; dependency licenses (cpal Apache-2.0, cidre MIT, Tauri
  MIT/Apache-2.0, whisper.cpp MIT) remain their own.

## 6. Build system and issue #911

- Frontend: pnpm, `frontend/pnpm-lock.yaml` `lockfileVersion: 9.0`; docs pin `pnpm@9.15.9` (`docs/BUILDING.md:9`), CI uses Node 20 + pnpm 9.15.9; Next **14.2.25** with `output: 'export'` (`next.config.js`), React 18. No `engines`/`packageManager` field.
- Rust: edition 2021, `rust-version = "1.77"` (root + member), Tauri 2.6.2, whisper-rs 0.13.2 (macOS features `metal`,`coreml`), ort rc.10, cidre `a9587fa`.
- Native/build-time deps: C++ toolchain + cmake (whisper.cpp 1.7.1, `cmake_minimum_required 3.5`; ggml 3.14), libclang for `bindgen 0.69` (present in Xcode), network access — `build.rs:21-22` downloads FFmpeg and (Windows only) ONNX Runtime at build time; macOS FFmpeg URL is `build/ffmpeg.rs:133` (live: HTTP 200, 22,400,365 B). Tauri `externalBin` requires `binaries/llama-helper-<triple>` and `binaries/ffmpeg-<triple>` (`tauri.conf.json:100-102`); the ffmpeg one is auto-downloaded, llama-helper is not.
- Tauri bundle targets: `deb`, `appimage`, `msi`, `nsis`, `app`, `dmg`.

**Issue #911** (`[BUG] [patch.crates-io] in frontend/src-tauri/Cargo.toml is ignored`, opened 2026-11-12): Cargo honors `[patch]` only in the workspace root. This checkout **does have the bug** — reproduced:

```
warning: patch for the non root package will be ignored, specify patch at the workspace root:
package:   .../meetily-v0.4.1/frontend/src-tauri/Cargo.toml
workspace: .../meetily-v0.4.1/Cargo.toml
```

and `Cargo.lock:1104-1107` shows `cpal 0.15.3` + registry checksum, `Cargo.lock:1944` shows registry `esaxx-rs 0.1.10`.

Exact fix, in order: (1) cut the three lines from `frontend/src-tauri/Cargo.toml`; (2) paste them into root `Cargo.toml` after `[workspace.dependencies]`; (3) re-resolve (`cargo update -p cpal`) so the lock records the git source; (4) verify with `cargo tree -i cpal` (must show `git+https://github.com/RustAudio/cpal?rev=51c3b43`). **Do not copy the block as-is into our repo**: `thewh1teagle/esaxx-rs` is gone (404) and `esaxx-rs` is unused, so the correct white-label action is to drop both the `esaxx-rs` dependency and its patch, and either keep crates.io cpal 0.15.3 or vendor the one-line macOS output fix.

## 7. KEEP / ADAPT / DELETE → `crates/memo-audio-capture`

Target layout is greenfield as of this analysis: `crates/` does not exist yet; `Cargo.toml:3` members only `frontend/src-tauri`.

| Upstream | Verdict | Target / action |
|---|---|---|
| `audio/capture/core_audio.rs` | **KEEP** (core) | `src/platform/macos/tap.rs` — retain cidre tap + aggregate-device recipe + `HeapRb`; replace `anyhow`, logging asserts, `Stream<Item=f32>` with block/slice delivery; add 14.4 availability guard |
| `audio/stream.rs` (CPAL builder) | **ADAPT** | `src/cpal_input.rs` — keep sample-format match; remove `RecordingState`, backend globals, `unsafe impl Send`; own streams on one thread |
| `audio/capture/system.rs` | **ADAPT** | `src/platform/macos/mod.rs` — keep device→stream entry, drop string-only device API and fake permission check |
| `audio/capture/backend_config.rs` | **DELETE** | explicit `CaptureConfig { backend }`; no global `RwLock`, no SCK-named enum |
| `audio/pipeline.rs` (mixer + resampler only) | **ADAPT** | `src/mixer.rs`, `src/resample.rs`, `src/dsp/*`; delete VAD/transcription/saver wiring |
| `audio/ffmpeg_mixer.rs` | **ADAPT** (optional) | `src/adaptive.rs` only if per-source gap handling is wanted; otherwise delete (misleading name, unused) |
| `audio/audio_processing.rs` | **ADAPT** | `src/resample.rs`, `src/dsp/{mono,hpf,loudness}.rs`; delete file/transcript writers |
| `audio/device_detection.rs`, `device_monitor.rs` | **ADAPT** | `src/device/{kind,monitor}.rs`; prefer OS transport type over name heuristics; event channel, not polling |
| `audio/devices/*` | **ADAPT** | `src/device/{mod,discovery,config}.rs`; drop `AudioTranscriptionEngine`, `LAST_AUDIO_CAPTURE`, output-name filtering |
| `audio/level_monitor.rs` | **ADAPT** | `src/level.rs` (RMS/peak, 20 Hz) |
| `audio/simple_level_monitor.rs` | **DELETE** | fake sine data (`:44-75`), registered at `lib.rs:318` |
| `audio/vad.rs`, `audio/transcription/*` | **DELETE** | belong to `memo-asr` / LiteRT, not capture |
| `audio/recording_state.rs`, `recording_manager.rs`, `recording_commands.rs`, `recording_saver.rs`, `incremental_saver.rs` | **DELETE** from crate; **ADAPT** command surface in app | `frontend/src-tauri/src/commands/audio.rs`, `services/recording.rs` |
| `audio/import.rs`, `retranscription.rs`, `decoder.rs`, `encode.rs`, `ffmpeg.rs`, `post_processor.rs`, `batch_processor.rs`, `hardware_detector.rs`, `system_detector.rs`, `diagnostics.rs`, `async_logger.rs`, `buffer_pool.rs`, `stt.rs`, `core-old.rs`, `system_audio_stream.rs`, `*.backup` | **DELETE** | reference only |
| `audio_v2/*` (9 files) | **DELETE** | non-compiling dead code |
| `devices/platform/windows.rs` | **ADAPT** | `src/platform/windows.rs`; WASAPI loopback |
| `devices/platform/linux.rs` | **REWRITE** | `src/platform/linux.rs`; Pulse/PipeWire monitor discovery, not ALSA name matching |

Proposed crate boundaries (no Tauri, no ASR, no `AppHandle`):

```
src/lib.rs        Capture, CaptureConfig, Frame, Level, CaptureError
src/device/       DeviceId, Direction, enumerate(), default_input/output()
src/platform/     macos/ (tap.rs, wake.rs), windows/ (loopback.rs), linux/ (monitor.rs)
src/ring.rs       single-producer/single-consumer ring, drop counters, no alloc in callback
src/mixer.rs      SampleAlignedMixer + per-source passthrough
src/resample.rs   persistent rubato SincFixedIn (512-frame staging)
src/dsp/          mono.rs, hpf.rs, loudness.rs (feature "loudness")
src/level.rs      RMS/peak + 20 Hz tick
src/clock.rs      monotonic PTS in ns
src/error.rs
```

LiteRT-specific rewrites: drop `whisper-rs`, `ort`, `silero`, `parakeet`, and the `TranscriptionProvider` trait; emit `Frame { source, samples: Arc<[f32]>, rate, pts_ns }` and let `memo-asr` request 16 kHz mono (rubato at the ASR boundary, not in capture); preserve **both** sources alongside the mix so LiteRT segments can be tagged `Me`/`Them` (upstream collapses both at `pipeline.rs:859-891`); move all DSP off the realtime callback; real level metering; macOS 14.4 gate + `LSMinimumSystemVersion`; no FFmpeg/llama-helper external bin in the audio crate.

## 8. Defects not to inherit

- `static mut SAMPLE_COUNTER` in the mixer hot path (`pipeline.rs:58-66`) — UB/data race.
- Sinc resampling, RNNoise and EBU R128 executed **inside the CPAL callback** under `std::sync::Mutex` (`pipeline.rs:399-600`) — priority inversion/dropouts.
- Fake level meter (`simple_level_monitor.rs:44-75`), wired to the public command (`lib.rs:318`).
- Permission check always returns `true` (`permissions.rs:18-25`); denied tap yields silence, with no UI signal.
- Window size drift: doc 50 ms vs code 600 ms (`pipeline.rs:31-41`); max-buffer comment 400 ms vs 4.8 s (`:48`).
- Mixer has dead constants `sys * 1.0`, unused `_mic_scaled = mic * 0.8` (`pipeline.rs:181-185`).
- No timestamp use in mixing; unbounded channels (`recording_state.rs:238`, `capture/system.rs:51-96`) and sample-by-sample `Stream<f32>` flattening can accumulate memory/latency.
- `audio_v2`, `stt.rs`, `core-old.rs`, `system_audio_stream.rs`, `recording_saver_old.rs` are orphaned; do not mistake them for live code.

## 9. Baseline build on this host (macOS 27.2.1 arm64, Xcode 27.2, rustc 1.100, cmake 4.5, protoc 36.2, Node 24.21, pnpm 12.11)

Not blockers: `protoc` (no prost/tonic in the graph), `cmake 4.5` (whisper.cpp min 3.5, ggml 3.14 — accepted), pnpm 12 + lockfile 9.0 (pnpm 12.11.2 emits `lockfileVersion: 9.0`, verified in a scratch install, so `--frozen-lockfile` should resolve), rustc 1.100 ≫ 1.77, Node 24 ≥ Next 14's `>=18.17`.

Blockers / risks, in order:

1. **`binaries/llama-helper-aarch64-apple-darwin` is missing** and `tauri.conf.json:100-102` requires it for bundling. `build.rs` provisions only ffmpeg. Must `cargo build -p llama-helper --release` (llama-cpp-2 0.1.146 → full llama.cpp build) and copy with the target triple, or remove `externalBin` for the baseline.
2. **Network required at build time** for FFmpeg (`build.rs:21`, 22 MB, URL live) and for `ort 2.0.0-rc.10` prebuilt runtime; a cached/offline build fails. `ffmpeg-sidecar` also tracks `branch = "main"` (lock-pinned today, unpinned tomorrow).
3. **Issue #911 is present** (warning only). Applying the "move the block" fix blindly makes the build fail: the `esaxx-rs` git remote is 404. Drop `esaxx-rs` + its patch, keep registry cpal or vendor the macOS fix.
4. **TCC/signing**: `signingIdentity: "-"` (ad-hoc) + `hardenedRuntime: true` means Microphone/Audio-Capture grants are tied to a rebuild-changing signature; expect permission resets when the binary changes. No `minimumSystemVersion` → the tap symbols imply 14.4+ but nothing enforces it.
5. **Time/disk**: whisper.cpp + llama.cpp + ONNX Runtime + node_modules ≈ several GB and 15–40 min cold build on an 8-core M1 Pro; `whisper-rs` `coreml` + `metal` additionally compile Metal shaders.
6. **Pre-existing source issues** may fail `cargo check` on a newer toolchain: `unsafe impl Send` for CPAL streams (`stream.rs:29`, `:38`), `static mut`, and unregistered modules are tolerated today but are lint debt.

Minimum viable baseline recommendation: validate the new `memo-audio-capture` crate on its own first, then for the upstream app strip `externalBin` and both dead patches and build `frontend/src-tauri` alone (whisper/parakeet features can stay compiled but unused; disabling `platform-default` changes nothing since it is empty).
