# Architecture

The application is one Tauri 2 desktop process plus a child LiteRT-LM worker. The renderer
is a static Next.js export; all privileged work happens in Rust behind typed commands and
events. There is no server component and no cloud dependency.

## Process model

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Tauri host (Rust)                                                    │
│                                                                      │
│  AppState                                                            │
│  ├─ Brand (embedded manifest + optional allow-listed override)       │
│  ├─ BrandPaths (data, cache, media, models, exports, DB)             │
│  ├─ Database (SQLite WAL + FTS5)                                     │
│  ├─ ModelDownloader (HF base URL, models dir, SHA-256)               │
│  ├─ HardwareProfile (RAM tier, Metal/XNNPACK, NPU label)             │
│  ├─ ScreenCapture (system or synthetic)                              │
│  ├─ CaptureLease + recording runtime                                 │
│  └─ SynthesisEngine (sidecar or UnavailableEngine)                   │
│                                                                      │
│  commands/*  ── invoke handler ──► typed results                     │
│  events.rs   ── emit ───────────► typed frontend listeners            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ stdio, 4-byte big-endian length + JSON
                    ┌───────────▼───────────┐
                    │ LiteRT-LM C++ worker  │
                    │ OmniEngine/Session    │
                    └───────────────────────┘
```

- The renderer never touches SQLite, files, or model files directly.
- `AppState::initialize` opens the vault, creates directories, constructs the downloader,
  and detects hardware once at startup.
- The sidecar is spawned lazily on the first synthesis request and kept warm. Missing
  worker or model selection resolves to `UnavailableEngine`, which returns a typed error.

## Renderer

- Next.js 15 App Router with `output: "export"` and `trailingSlash: true`; `frontend/out`
  is the Tauri `frontendDist`.
- `frontend/src/lib/tauri.ts` is the transport boundary: `invokeCommand` returns `null`
  outside Tauri or on a rejected invoke, and `listenEvent` returns a no-op disposer.
- `frontend/src/lib/host.ts` exposes typed command helpers; `hooks/use-host-event.ts`
  exposes typed event hooks. Event names and camelCase payloads mirror `events.rs`.
- The demo vault (`lib/demo-data.ts`) has the same shape as repository records, so native
  data can replace it without changing component props.
- Zustand stores hold UI-only state: player clock, synthesis evidence focus, toasts,
  sidebar, speaker labels, selected model. Durable state lives in SQLite.

## Command surface

| Domain | Commands |
| --- | --- |
| Brand | `get_brand_config`, `get_brand_manifest` |
| Meetings | `create_meeting`, `list_meetings`, `get_meeting`, `finish_meeting`, `delete_meeting`, `set_meeting_starred`, `set_screenshot_interval`, `start_recording`, `stop_recording`, `recording_status` |
| Notes | `save_notes`, `list_notes` |
| Transcript | `append_transcript`, `list_transcript`, `list_speakers`, `upsert_speaker`, `rename_speaker` |
| Screenshots | `list_screenshots`, `capture_screenshot`, `update_screenshot_ocr` |
| Synthesis / export | `synthesize_meeting`, `list_synthesis`, `update_synthesis_item`, `synthesis_context_preview`, `export_meeting` |
| Search / folders | `search`, `rebuild_search_index`, `create_folder`, `list_folders` |
| Models | `list_models`, `probe_hardware`, `download_model`, `delete_model` |

## Event contract

| Event | Payload highlights | Emitted by |
| --- | --- | --- |
| `audio:levels` | `meetingId`, `channel`, `rmsDbfs`, `peakDbfs`, `atMs` | audio capture adapter (contract ready) |
| `asr:segment-delta` | `meetingId`, `seqNo`, `startMs`, `endMs`, `speakerLabel`, `text`, `isFinal` | ASR adapter / `append_transcript` path |
| `screenshot:captured` | `meetingId`, `screenshot`, `deduplicated`, `reason` | interval task and manual capture |
| `synthesis:progress` | `meetingId`, `stage`, `percent`, `message` | synthesis orchestrator |
| `models:download-progress` | `artifactId`, `filename`, `downloadedBytes`, `totalBytes`, `percent`, `phase` | downloader |
| `meeting:changed` | `meeting` | create/start/stop/star/interval mutations |

`events.rs` exposes `ALL` so tests can assert the contract stays complete.

## Storage

`migrations/0001_initial.sql` creates:

- `folders`, `meetings`, `meeting_tags`
- `note_blocks`, `speakers`, `transcript_segments`
- `screenshots`, `synthesis_items`
- `meetings_search_fts` (FTS5, `porter unicode61 remove_diacritics 1`)
- `meeting_search_documents` view and refresh triggers for every indexed table

FTS covers title, manual notes, transcript text, synthesis content, screenshot OCR, and
speaker names. Search returns `bm25` rank and `snippet()` highlights. Renaming a speaker
refreshes every affected meeting.

SQLite runs in WAL mode with a bounded pool. Every meeting-scoped table cascades on delete.
Synthesis items store evidence as JSON and a user-edited flag so generated content can be
corrected without losing provenance.

## Synthesis pipeline

```text
meeting + notes + transcript + screenshots
        │
        ▼
context builder  ── stable IDs: [T-MM:SS] [N-L#] [S-MM:SS]
        │
        ▼
prompt (brand-aware) ──► SynthesisEngine
        │                 (LiteRT-LM sidecar, temperature 0)
        ▼
strict JSON parser ── tolerates fences/prose, rejects invalid shape
        │
        ▼
deterministic verifier
  ├─ drop items with no valid evidence
  ├─ strip invalid evidence refs
  ├─ force ungrounded owner → "Unassigned"
  └─ force ungrounded deadline → "Not specified"
        │
        ▼
repository write + VerificationReport + synthesis:progress events
```

The verifier is the security boundary, not the prompt. Screenshot-only evidence can support
a visual claim but cannot ground an owner or deadline; those require transcript or note
citations. The report counts raw/kept items, dropped items, stripped refs, and forced
substitutions.

## Screenshot engine

1. `start_recording` opens a single-session `CaptureLease`, marks the meeting `recording`,
   and starts an interval task when `screenshot_interval_sec > 0`.
2. Each tick captures a frame (`/usr/sbin/screencapture -x -t png` on macOS, or the
   synthetic backend when `MEMO_SYNTHETIC_CAPTURE=1`).
3. `dhash` computes a 64-bit perceptual hash; the scheduler compares it with the last frame
   and suppresses unchanged slides. Manual snaps use the same hash gate.
4. Accepted frames are encoded to WebP, stored under `media/<meeting>/shots`, and inserted
   into `screenshots` with a meeting-relative start/end.
5. `screenshot:captured` reports the row or the dedup reason. The UI updates the filmstrip.
6. `export_meeting` copies images into the vault folder as relative WebP assets and writes
   `index.md` with YAML frontmatter, evidence-linked synthesis, transcript, and screenshots.

The capture lease prevents two meetings (or two windows) from capturing at once.

## Model registry and downloader

- `HardwareProfile::detect` reads RAM and architecture, assigns `low` / `mid` / `high`, and
  selects ASR/SLM artifacts from the brand's `modelRegistry`.
- `ModelDownloader` accepts only `https://` or loopback `http://` base URLs.
- Downloads resume with HTTP Range, stream to a temporary file, enforce the declared size,
  verify SHA-256 when the registry supplies a digest, then atomically move the artifact
  into `models/`.
- Progress is emitted as `models:download-progress`; deletion is artifact-scoped.

## White-label build path

```text
brand/brand.config.json
  + brand/profiles/<profile>.json (optional deep merge)
        │
        ▼ scripts/apply-brand.ts
  tauri.conf.json · capabilities/default.json · icons · resources/brand.config.json
  generated_brand.rs · generated/brand.ts · brand-tokens.css · resolved manifest
```

Runtime loading reparses the embedded manifest, validates identity/storage fields, and
merges only `productName`, `tagline`, `theme`, `assets`, `features`, and `prompts` from
`brand.override.json`. This prevents an override from redirecting the vault, database, or
model directory.

## Failure behavior

| Condition | Behavior |
| --- | --- |
| Browser preview | `invoke`/`listen` resolve to `null`/no-op; demo data stays visible |
| Host invoke rejects | Typed warning, local state preserved |
| Model missing | Download button remains available; synthesis fails closed with a typed error |
| Worker missing/model absent | `UnavailableEngine`, no cloud fallback |
| Sidecar protocol error | Typed error, client dropped; next request respawns |
| Duplicate slide | No file, no row; event reports `deduplicated: true` |
| Invalid model evidence | Item dropped; report increments |
| Ungrounded owner/deadline | Forced placeholders; report increments |
| Screenshot permission denied | Typed capture error with macOS guidance |
| Non-macOS system capture | Typed "not implemented" error; synthetic backend still works |

## Related documents

- [White-label and rebranding](./rebranding.md)
- [Offline policy](./offline-policy.md)
- [Acceptance and verification](./acceptance.md)
