# TODO — White-Label Use Memo Platform

Branch: `feat/white-label-platform`

Each completed item is committed separately. Legend: `[ ]` pending, `[~]` in progress, `[x]` done,
`[!]` blocked on a documented external requirement.

## M0 — Repository & planning

- [x] M0.1 Create `feat/white-label-platform` branch
- [x] M0.2 Write execution TODO and milestone map
- [x] M0.3 Scaffold monorepo root (pnpm workspace, scripts, ignore rules)
- [x] M0.4 Commit planning baseline

## M1 — Host probe & upstream bootstrap

- [x] M1.1 Implement `scripts/probe-host-hardware.sh` and emit `build-env.json`
- [x] M1.2 Run probe on host and commit generated report
- [x] M1.3 Clone upstream `Zackriya-Solutions/meetily` at stable tag and document revision
- [x] M1.4 Inspect upstream audio capture stack and write harvest map
- [x] M1.5 Extract/clean dual-stream ring-buffer audio crate (`crates/memo-audio-capture`)
- [x] M1.6 Record upstream Cargo `[patch.crates-io]` fix in workspace root
- [!] M1.7 Full upstream baseline `pnpm tauri build --debug` — Rust/cmake/protobuf are installed, but upstream
      still needs an unshipped `llama-helper` binary plus network FFmpeg/ONNX downloads; recorded as blocked

## M2 — White-label build engine

- [x] M2.1 Author `brand/brand.config.json` and secondary brand profile
- [x] M2.2 Author brand assets (icon, wordmarks, tray template)
- [x] M2.3 Implement `scripts/apply-brand.ts` codegen (Tauri config, TS, Rust, CSS, resources)
- [x] M2.4 Generate and commit brand outputs; add `brand:apply` / `brand:check` scripts
- [x] M2.5 Add brand codegen tests and prove secondary-profile rebrand
- [x] M2.6 Implement runtime `brand.override.json` merge in Rust
      (allow-listed theme/assets/prompts only; identity and vault paths are immutable)


## M3 — Core domain: storage, synthesis, verifier

- [x] M3.1 SQLite schema + FTS5 migrations (meetings, notes, speakers, transcripts, screenshots, synthesis, FTS)
- [x] M3.2 Storage repository with migrations, FTS5 search (`bm25`, `snippet`), and tests
- [x] M3.3 Grounded context builder with indexed `[N-L#]`, `[T-MM:SS]`, `[S-MM:SS]` sources
- [x] M3.4 Deterministic anti-hallucination verifier (evidence, owner, deadline gates) + tests
- [x] M3.5 Synthesis orchestrator with strict JSON parsing (fences/prose tolerated) and fail-closed behavior
- [x] M3.6 Markdown vault exporter with YAML frontmatter and relative WebP assets + tests
- [x] M3.7 Screenshot dHash deduplication, WebP path planner, and interval policy + tests
- [x] M3.8 Hardware-to-model tier selector and LiteRT model registry + tests

## M4 — Tauri application shell & IPC

- [x] M4.1 Tauri 2 config generation, capabilities, app/lib entrypoints
- [x] M4.2 Tauri commands for brand, sessions, notes, screenshots, synthesis, search, export, models
- [x] M4.3 Event contract constants and typed frontend event hooks (`audio:levels`, `asr:segment-delta`, `screenshot:captured`, `synthesis:progress`, `models:download-progress`)
- [x] M4.4 Screenshot scheduler core (interval, manual snap, single-session capture lease)
- [x] M4.5 LiteRT model downloader core (resumable, SHA-256 verification) + tests
- [x] M4.6 Tauri `cargo check` / unit-test pass on host

## M5 — LiteRT-LM sidecar bridge

- [x] M5.1 C++20 `OmniEngine`/`OmniSession` worker source (`crates/memo-litert-bridge/cpp`)
- [x] M5.2 Length-prefixed stdio IPC protocol + Rust client/session types
- [x] M5.3 Bazel/CMake build scaffold and sidecar bundling docs
- [!] M5.4 Compile worker against upstream LiteRT-LM — requires Bazel + multi-GB native build, not run on this host session

## M6 — White-label UI (Next.js 15 / React 19)

- [x] M6.1 Next.js static-export shell, brand tokens, theme provider
- [x] M6.2 View 1: sidebar + command/search palette
- [x] M6.3 View 2: synchronized 3-pane meeting studio (notes, transcript, filmstrip)
- [x] M6.4 View 3: detached floating recording HUD route
- [x] M6.5 View 4: synthesis bento canvas with evidence chips + bidirectional highlight state
- [ ] M6.6 View 5: LiteRT model manager / hardware studio
- [ ] M6.7 UI typecheck + production static build

## M7 — Verification & delivery

- [ ] M7.1 Air-gapped guard: no cloud SDK/endpoint strings; network policy test
- [x] M7.2 Hallucination acceptance test: `"Bob"` → `"Unassigned"`, `"Next Friday"` → `"Not specified"`
- [x] M7.3 White-label rebrand acceptance test (secondary profile changes title, storage dir, accents)
- [x] M7.4 Screenshot/export acceptance test on synthetic 35s session
- [ ] M7.5 Full test suite + format/lint gate
- [ ] M7.6 Final docs, commit log audit, and branch summary

## Known external blockers

- Native LiteRT-LM worker compilation requires Bazel and the upstream `google-ai-edge/LiteRT-LM`
  tree. The source, IPC contract, and build scaffold are committed; compilation is out of scope for
  this host session because it is a multi-GB native build.
- Actual model weights are multi-GB downloads from `huggingface.co/litert-community` and are not
  vendored in git. Downloader + SHA-256 verification are implemented and tested with fixtures.
