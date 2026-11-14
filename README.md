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
| System-audio loopback and speaker diarization | Not implemented; the UI marks both as planned and does not fake them |
| Signed/notarized distributable | Not produced in this workspace |

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
docs/                      Architecture, rebranding, offline policy, acceptance, blockers
frontend/src               Next.js application (static export)
frontend/src-tauri         Tauri host and Rust domain logic
scripts/                   Brand codegen, host probe, air-gap tests
TODO.md                    Milestone checklist and commit map
```

---

## Requirements

- Node.js **>= 20.9** and pnpm **12.11.2** (`corepack enable`).
- Rust **1.77.2+** with `rustfmt` and `clippy`.
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
```

The browser build serves the demo vault and is the fastest way to review the UI. Native
commands are only available inside `pnpm tauri:dev` / `pnpm tauri:build`.

## Quality gates

```bash
pnpm brand:check
pnpm brand:test
pnpm airgap:test
pnpm typecheck
pnpm build
pnpm format:check
pnpm test                 # brand + air-gap + entire Rust workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected Rust totals on this host: **25** audio tests, **8** bridge tests, **80** Tauri
unit tests, and **1** end-to-end screenshot/vault acceptance test.

The screenshot/vault acceptance runs without a display by using the synthetic capture
backend. macOS system capture is exercised only through the UI.

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
- **Model weights** — ASR/SLM/diarization artifacts are large Hugging Face downloads and are
  not vendored. The catalog pins Whisper small/tiny and Gemma E2B/E4B digests; the
  downloader rejects any byte that does not match.
- **Audio path** — microphone capture, WAV archival, and post-recording whisper.cpp
  transcription work on the recorded macOS host. System-audio loopback (ScreenCaptureKit),
  diarization, and iOS/Android capture plumbing are not implemented. The demo studio still
  renders the pinned demo vault; real takes appear in **Local recordings** on the dashboard.
- **Screenshot platforms** — system capture is implemented for macOS; other platforms need
  a backend. Tests use the deterministic synthetic backend.
- **Distribution** — signing, notarization, updater artifacts, and CI packaging are out of
  scope for this workspace.

Details and acceptance evidence: [docs/external-blockers.md](./docs/external-blockers.md)
and [docs/acceptance.md](./docs/acceptance.md).

## Documentation

- [Delivery summary](./docs/delivery-summary.md)
- [Architecture](./docs/architecture.md)
- [White-label and rebranding](./docs/rebranding.md)
- [Offline policy](./docs/offline-policy.md)
- [Acceptance and verification](./docs/acceptance.md)
- [External blockers](./docs/external-blockers.md)
- [Upstream harvest (read-only analysis)](./docs/upstream-harvest.md)

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).

The upstream Meetily v0.4.1 checkout was analyzed read-only as behavioral reference; no
upstream source is vendored in this repository. Third-party Rust and npm dependencies keep
their own licenses.
