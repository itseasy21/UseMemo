# Use Memo

**Local-First AI Meeting & Note Studio** — a white-label Tauri 2 + Next.js 15 desktop
application that records, transcribes, summarizes, and exports meetings without sending
content to a cloud service.

This repository is the reference implementation of the white-label platform. The default
brand is **Use Memo**; a second profile (`clinical-scribe-offline`) proves that identity,
theme, storage paths, icons, and model selection can be replaced without editing source
code.

Licensed under **GPL-3.0-or-later**. See [LICENSE](./LICENSE).

---

## Status at a glance

| Area | State |
| --- | --- |
| Five-view Next.js UI, static export | Working |
| Brand codegen + secondary profile + runtime override allowlist | Working |
| SQLite schema, FTS5 search, repository layer | Working |
| Anti-hallucination evidence verifier | Working, deterministic tests |
| Screenshot capture, dHash dedup, WebP storage, vault export | Working (macOS capture backend; synthetic backend for tests) |
| Model registry, resumable downloads, mandatory SHA-256 | Working; every catalog artifact pins a publisher digest; weights not vendored |
| Tauri IPC commands, typed events, browser fallback | Working |
| LiteRT-LM C++ worker source + stdio protocol | Implemented; native compilation blocked (see below) |
| Microphone capture → WAV → on-device transcription | Working (whisper.cpp; post-recording, block-based) |
| System-audio loopback | Implemented on macOS (ScreenCaptureKit); the gated real-capture acceptance passes on the recorded host. WASAPI backend type-checks for the Windows target but has not run on a Windows host |
| Speaker diarization | Working on the loopback archive: on-device acoustic clustering into `Speaker 1…N`, with `You`/`Them` fallbacks. Two synthesized voices captured through loopback separate correctly; acoustic clustering, not voice identification |
| Mobile capture | Android arm64 permission/session/capture path verified on an API 36 emulator; iOS, physical-device behavior, audible signal, and ASR in the test APK remain unverified |
| Signed/notarized distributable | Packaging, checksums, and CI are implemented; notarization is not possible on this host because only an Apple Development certificate is installed |

The browser preview is fully local: it runs the demo vault and never calls a network API.
Inside Tauri, the same screens call native commands and listen for native events; rejected
calls fall back to the demo data instead of breaking the UI.

---

## Features

- **Five product surfaces** — vault dashboard and command palette, synchronized three-pane
  meeting studio (notes / transcript / filmstrip), detached recording HUD, synthesis bento
  canvas with bidirectional evidence highlighting, and Model Studio.
- **Grounded synthesis** — every summary item, decision, and action item must cite
  `[T-MM:SS]`, `[N-L#]`, or `[S-MM:SS]` evidence. The verifier drops ungrounded items,
  strips invalid citations, and forces unsupported owners/deadlines to `Unassigned` and
  `Not specified`.
- **Local vault** — SQLite with FTS5, meetings, notes, speakers, transcript segments,
  screenshots, synthesis items, folders, tags, and search snippets ranked with `bm25`.
- **Screenshot engine** — interval scheduler with a single-session capture lease, dHash
  duplicate suppression, WebP encoding, and relative-path Markdown export.
- **On-device transcription** — microphone capture goes through `cpal` into the clean-room
  mixer, then a 16 kHz mono WAV that is written while the meeting runs. A finished take is
  decoded in 30-second blocks and transcribed with whisper.cpp (`whisper-rs`), with silent
  blocks skipped. No network call is involved.
- **Two-channel capture** — when the host supports it, ScreenCaptureKit (macOS) or WASAPI
  loopback (Windows) writes a second, independent `audio-system.wav`. The transcript merges
  both archives on one timeline and labels microphone segments `You` and loopback segments
  `Them`. A failed tap cannot corrupt the microphone take.
- **Speaker diarization** — after the take, the loopback archive is segmented by energy VAD,
  embedded with MFCC statistics, and clustered deterministically. Separable voices become
  `Speaker 1`, `Speaker 2`, …; short, overlapping, or single-voice audio stays `Them`. The
  microphone is always `You`. No model download, no voiceprint store, no network.
- **Model Studio** — hardware tiering, model registry, download progress events, resume
  support, declared-size enforcement, and mandatory SHA-256 verification.
- **White-label engine** — one manifest generates Tauri config, capabilities, icons,
  TypeScript, Rust, and CSS tokens. A secondary profile and a restricted runtime override
  prove the contract.
- **Air-gap guard** — tests reject cloud SDKs, analytics vendors, unexpected remote hosts,
  permissive CSP `connect-src`, and browser network primitives in UI code.

---

## Architecture

```text
frontend/src (Next.js 15, static export)
  │  typed invoke / listen
  │  lib/tauri.ts · lib/host.ts · hooks/use-host-event.ts
  ▼
frontend/src-tauri (Tauri 2 host)
  ├─ commands/*      ──► storage (SQLite + FTS5) and vault export
  ├─ screenshot/*    ──► scheduler → dHash → WebP → screenshot row/event
  ├─ synthesis/*     ──► context → engine → strict parse → verifier → rows
  ├─ models/*        ──► registry → resumable download → SHA-256 → models dir
  └─ brand.rs        ──► embedded manifest + allow-listed runtime override
                              │
                     memo-litert-bridge (4-byte length + UTF-8 JSON over stdio)
                              │
                     C++20 LiteRT-LM worker (OmniEngine / OmniSession)
```

Rust workspace members:

- `frontend/src-tauri` — application host, domain logic, storage, commands, events.
- `crates/memo-audio-capture` — dependency-free dual-stream DSP: ring buffers, mixing,
  downmix, resampling. No OS bindings and no network code.
- `crates/memo-litert-bridge` — Rust client, framing, timeouts, and the C++ worker
  scaffold/build files.

### Repository layout

```text
brand/                     Brand manifest, profile, assets, resolved output
crates/                    Audio DSP and LiteRT-LM bridge crates
docs/                      Architecture, rebranding, offline policy, acceptance, mobile, blockers
frontend/src               Next.js application (static export)
frontend/src-tauri         Tauri host and Rust domain logic
scripts/                   Brand codegen, host probe, air-gap tests
TODO.md                    Milestone checklist and commit map
```

---

## Requirements

- Node.js **>= 20.9** and pnpm **12.11.2** (`corepack enable`).
- Rust **1.90+** with `rustfmt` and `clippy` (the floor of the resolved Tauri 2.12 graph).
- Tauri 2 system prerequisites (Xcode Command Line Tools on macOS; WebView2 on Windows;
  WebKitGTK on Linux).
- macOS **13.0+** for the generated bundle. System screenshot capture needs macOS Screen
  Recording permission; the native audio path will additionally need microphone and
  system-audio permissions when the platform adapters are wired.
- CMake + a C++20 toolchain only for building the LiteRT-LM worker.
- Bazel and the upstream LiteRT-LM tree only for the full native worker build.

The committed host probe is in [build-env.json](./build-env.json). Regenerate it with
`pnpm probe`.

## Quick start

```bash
pnpm install
pnpm brand:check          # generated config/icons/TS/Rust/CSS are current
pnpm dev                  # browser preview at http://localhost:3000
pnpm tauri:dev            # native desktop shell
pnpm package:release      # signed-or-ad-hoc installers + SHA-256 manifest
```

The browser build serves the demo vault and is the fastest way to review the UI. Native
commands are only available inside `pnpm tauri:dev` / `pnpm tauri:build`.

## Quality gates

```bash
pnpm brand:check
pnpm brand:test
pnpm package:test
pnpm airgap:test
pnpm typecheck
pnpm build
pnpm format:check
pnpm test                 # brand + air-gap + entire Rust workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected Rust totals on this host: **41** audio-core tests, **8** bridge tests, **18**
diarization tests, **5** mobile-plugin tests, **101** Tauri unit tests, one screenshot/vault
acceptance test, and three gated real-device tests (ASR, system-audio loopback, and
two-voice diarization).

The screenshot/vault acceptance runs without a display by using the synthetic capture
backend. macOS system capture is exercised only through the UI.

The real-device system-audio check is opt-in and needs Screen Recording permission plus an
audible output device:

```bash
MEMO_SYSTEM_AUDIO_E2E=1 cargo test -p use-memo \
  --test system_audio_acceptance -- --nocapture
```

It plays a short tone with `afplay` and asserts that ScreenCaptureKit delivered non-silence.
The gated check now passes on the recorded host; without the grant it skips with
instructions instead of failing.

The two-voice diarization check uses the same capture path with two synthesized macOS
voices and asserts that they cluster into `Speaker 1` and `Speaker 2`:

```bash
MEMO_DIARIZATION_E2E=1 cargo test -p use-memo \
  --test diarization_acceptance -- --nocapture
```

It needs the same Screen Recording grant and skips when a voice or the grant is missing.

The Windows backend can be type-checked and linted from macOS (it is pure Rust):

```bash
rustup target add x86_64-pc-windows-msvc
bash scripts/check-windows-backend.sh
```

That proves the `wasapi` API usage compiles; it does not prove capture. A Windows host is
still required for the runtime acceptance.

---

## White-label in one command

```bash
pnpm brand:apply --profile=clinical-scribe-offline
pnpm typecheck && pnpm build
```

`brand/brand.config.json` is the single source of truth. Codegen rewrites
`tauri.conf.json`, capabilities, icons, `generated/brand.ts`, `generated_brand.rs`,
`brand-tokens.css`, the embedded runtime manifest, and the resolved manifest. See
[docs/rebranding.md](./docs/rebranding.md) for every field, the immutable identity
fields, and runtime override rules.

Revert with:

```bash
pnpm brand:apply
```

## Data locations

Paths are derived from `storageDirName` and `sqliteFileName` only:

| Platform | Data root |
| --- | --- |
| macOS | `~/Library/Application Support/<storageDirName>/` |
| Linux | `~/.local/share/<storageDirName>/` |
| Windows | `%APPDATA%\\<storageDirName>\\` |

Inside the root:

```text
<sqliteFileName>       SQLite vault (WAL)
media/<meeting>/       audio and per-meeting assets
media/<meeting>/shots  WebP screenshots
models/                verified LiteRT artifacts
exports/               Markdown vault exports
brand.override.json    optional runtime theme/asset/feature/prompt override
```

A runtime override may change only `productName`, `tagline`, `theme`, `assets`, `features`,
and `prompts`. Identity, bundle identifier, and vault/model paths remain build-time values.

## Offline and privacy policy

- No analytics, telemetry, crash reporting, accounts, or cloud inference providers.
- The only remote operation is an explicit model download from `huggingface.co`, pinned
  by filename and declared size, with a SHA-256 gate when the registry supplies a digest.
  No automatic background fetch exists.
- The UI CSP allows local assets and the Tauri IPC origins only.
- `scripts/airgap.test.ts` fails the suite if a forbidden vendor/SDK string, unexpected
  remote host, wildcard `connect-src`, or browser network primitive appears.
- Inference, search, storage, screenshots, export, and the demo vault are on-device.

See [docs/offline-policy.md](./docs/offline-policy.md) for the allowlist and audit steps.

## Anti-hallucination contract

The synthesis pipeline is deliberately stricter than the language model:

1. Context builders assign stable source IDs to transcript segments, note lines, and
   screenshots.
2. The model is instructed to return JSON where every item carries evidence refs.
3. The parser tolerates fences/prose but rejects malformed JSON outright.
4. The verifier validates every ref against the assembled context and drops items with no
   valid evidence.
5. Owner and deadline are accepted only when grounded in transcript/note evidence; otherwise
   they are replaced with `Unassigned` / `Not specified`.
6. The response reports raw/kept counts and every forced substitution.

The acceptance test is
`acceptance_check_invented_owner_and_deadline_are_deterministically_replaced`.

## LiteRT-LM sidecar

The host spawns `memo-litert-worker` (or `litert-lm-worker`, or `MEMO_LITERT_WORKER`) next
to the app binary, performs `hello`, loads the default SLM, then streams tokens over a
length-prefixed JSON protocol. If the worker or model is missing, the app uses
`UnavailableEngine` and fails closed — it never falls back to a cloud model.

Build the worker scaffold:

```bash
cmake -S crates/memo-litert-bridge/cpp -B /tmp/memo-litert-worker-build
cmake --build /tmp/memo-litert-worker-build
```

The protocol and framing limits are documented in
[`crates/memo-litert-bridge/cpp/README.md`](./crates/memo-litert-bridge/cpp/README.md).

## Known blockers and follow-ups

- **M1.7 upstream baseline** — upstream requires an unshipped `llama-helper` binary and
  build-time FFmpeg/ONNX downloads; this repository does not carry that baseline.
- **M5.4 native worker** — compiling against upstream LiteRT-LM needs Bazel and a multi-GB
  native tree. The C++ source, protocol, and CMake/Bazel scaffolds are committed.
- **Model weights** — ASR/SLM artifacts are large Hugging Face downloads and are not
  vendored. The catalog pins Whisper small/tiny and Gemma E2B/E4B digests; the downloader
  rejects any byte that does not match. Diarization needs no artifact.
- **Audio path** — microphone capture, WAV archival, and post-recording whisper.cpp
  transcription work on the recorded macOS host. The gated macOS system-audio loopback
  acceptance now passes on this host; the WASAPI backend compiles and lints for
  `x86_64-pc-windows-msvc` via `scripts/check-windows-backend.sh` but has not run on a
  Windows host here. Diarization is acoustic clustering of the loopback (`Speaker N` when
  voices separate, `Them` otherwise), not voice identification. Two synthesized voices
  captured through ScreenCaptureKit separate correctly; a real human meeting and
  overlapping speech remain unverified. Android arm64 permission/session/capture is compiled
  and verified on an emulator; iOS, physical-device behavior, audible signal, and ASR in the
  test APK remain unverified; see [docs/mobile.md](./docs/mobile.md). System audio does not
  echo-cancel, so headphones are recommended.
  The demo studio still renders the pinned demo vault; real takes appear in **Local
  recordings** on the dashboard.
- **Screenshot platforms** — system capture is implemented for macOS; other platforms need
  a backend. Tests use the deterministic synthetic backend.
- **Distribution** — `pnpm package:release` builds a DMG/MSI/AppImage-family installer, verifies the
  macOS signature and audio-input entitlement, and writes `SHA256SUMS.txt` plus
  `release-manifest.json`. macOS notarization is blocked on this host: only an Apple Development
  certificate is installed, and notarization requires a Developer ID Application certificate plus
  Apple credentials. The CI workflow packages all three desktop platforms but has not been executed
  here. In-app update checks stay disabled to preserve the air gap; see
  [docs/packaging.md](./docs/packaging.md).

Details and acceptance evidence: [docs/external-blockers.md](./docs/external-blockers.md)
and [docs/acceptance.md](./docs/acceptance.md).

## Documentation

- [Delivery summary](./docs/delivery-summary.md)
- [Architecture](./docs/architecture.md)
- [White-label and rebranding](./docs/rebranding.md)
- [Offline policy](./docs/offline-policy.md)
- [Acceptance and verification](./docs/acceptance.md)
- [Packaging and release](./docs/packaging.md)
- [Mobile audio](./docs/mobile.md)
- [External blockers](./docs/external-blockers.md)
- [Upstream harvest (read-only analysis)](./docs/upstream-harvest.md)

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).

The upstream Meetily v0.4.1 checkout was analyzed read-only as behavioral reference; no
upstream source is vendored in this repository. Third-party Rust and npm dependencies keep
their own licenses.
