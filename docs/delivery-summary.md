# Delivery summary

Branch: `feat/white-label-platform`
State: local-only branch, no remote configured, nothing pushed.

This document closes M7.6: the final documentation, commit-log audit, and branch summary.

## Delivered scope

| Milestone | Outcome |
| --- | --- |
| M0 | Branch, monorepo scaffold, commit plan, baseline |
| M1 | Host probe and reference report; upstream v0.4.1 harvested read-only; clean-room audio DSP crate |
| M2 | Brand manifest, secondary profile, assets, deterministic codegen, runtime allowlist |
| M3 | SQLite/FTS5 vault, grounded context, verifier, orchestrator, exporter, screenshot policy, model tiers |
| M4 | Tauri commands/events, capture scheduler, downloader, host test pass |
| M5 | LiteRT-LM worker source, stdio protocol, Rust client, CMake/Bazel scaffolds (native build blocked) |
| M6 | Five UI surfaces, typed event wiring, HUD window, Model Studio, typecheck and static export |
| M7 | Air-gap guard, hallucination acceptance, rebrand acceptance, screenshot/export acceptance, full gate, docs |

## Production audio slice

After the M7 closeout, the real capture → transcription path was implemented and verified:

| Piece | Result |
| --- | --- |
| Microphone capture | `cpal` on a dedicated thread; bounded channel; mono downmix; backpressure counted |
| Archive | Streaming 16 kHz mono 16-bit WAV, RIFF header patched on finalize and on `Drop` |
| Capture session | Mixer → 48 kHz internal → 16 kHz archive; peak/RMS meter; `audio:levels`; silence flag |
| Recording lifecycle | Capture starts before the DB marks recording; rollback on failure; `recording:stopped` carries silence/overrun facts |
| ASR engine | whisper.cpp via `whisper-rs 0.16`, behind an `AsrEngine` trait; CPU-only, logs suppressed |
| Transcription | 30 s blocks, silence skipping, transactional transcript replacement, `asr:progress` |
| System audio | macOS ScreenCaptureKit audio-only tap → independent `audio-system.wav`; WASAPI backend type-checks for the Windows target, not run here |
| Channel merge | Both archives decoded on one clock; microphone `You`, loopback `Them`; renumbered `seq_no` |
| Model integrity | `ModelFile.sha256` is mandatory; real Whisper and Gemma digests pinned |
| macOS permission | `NSMicrophoneUsageDescription` + audio-input entitlement generated into the bundle; Screen Recording requested for loopback |
| UI | Local recordings panel lists real takes, shows transcripts, and runs transcription with progress; the new-recording dialog probes `audio_capabilities` and meters both channels |
| Honesty | Speaker diarization stays disabled and labelled; echo cancellation is explicitly absent; Windows loopback and the macOS runtime capture (TCC denied here) are marked unverified |

Real-model evidence:

```text
ASR transcript: The quarterly launch review starts on Monday, we decided to delay the beta by two weeks.
test whisper_transcribes_known_speech_with_timestamps ... ok
```

## Verification evidence

Final gate run on the recorded host:

```text
pnpm brand:check   Brand outputs are current for Use Memo.
pnpm brand:test    12 passed
pnpm airgap:test   5 passed
cargo test         41 audio + 8 bridge + 100 host + 3 acceptance (2 gated skip by default)
MEMO_SYSTEM_AUDIO_E2E=1 ...  skipped: Screen Recording denied to the test process
pnpm typecheck     clean
pnpm build         12 static pages exported
prettier --check   clean
cargo fmt --check  clean
cargo clippy ...   Finished with -D warnings (host + audio crate)
```

That is **161 automated checks** (17 TypeScript/Node, 144 Rust), including one gated ASR
acceptance that ran with a real 190 MB Whisper model and produced the transcript above.
The manual native and browser fallback checklists are in [acceptance.md](./acceptance.md).

## Commit audit

The branch contains the original foundation commits followed by the delivery sequence.
Every M4-M7 item added after the review has its own commit; early foundation commits group
tightly coupled milestones (for example, schema + verifier + orchestrator) because they
share the same migration and test surface.

Recent delivery commits:

```text
f1dfd66 style: apply rustfmt across the Rust workspace
234ecb5 fix(screenshot): expose scheduler session accessor for capture commands
149818c test: record passing Tauri check and unit suite (M4.6)
b6d4d05 feat(sidecar): add LiteRT-LM worker bridge and fail-closed engine selection
7e14f23 feat(ipc): add typed frontend host event hooks and command facade
5826efc feat(ui): add the vault shell, sidebar, dashboard, and command palette
113b18c feat(ui): add the synchronized three-pane meeting studio
0fa5e68 feat(ui): add the detached recording HUD route and window reveal
9158b5f feat(ui): add the synthesis bento canvas with bidirectional evidence focus
259864d feat(ui): add the LiteRT model manager and hardware studio
d887d24 test(security): enforce the air gap and remove source-level brand strings
dbdf06e fix(brand): generate HUD window permissions in the capability file
5ac4fad build(ui): record passing typecheck and production static export (M6.7)
7f54802 fix(tauri): wire the deep-link plugin declared by the brand config
b657980 chore(license): relicense the project under GPL-3.0-or-later
28e52d0 test: record the passing full suite, typecheck, build, and lint gate (M7.5)
0b77374 docs: add delivery, architecture, rebranding, offline, acceptance, and blocker guides
```

Audit checks:

- Working tree clean before the summary commit.
- `TODO.md` has no pending items; `M1.7` and `M5.4` remain explicitly blocked.
- `LICENSE` is GPL-3.0-or-later and matches `Cargo.toml`, both package manifests, the brand
  manifest, and `generated_brand.rs`.
- No `target/`, `out/`, `node_modules/`, or `.next/` content is tracked.
- No generated file is stale (`brand:check`).
- The deep-link plugin is initialized, so the generated `plugins.deep-link` config is not
  dangling.
- No remote is configured and no commit was pushed.

## Blocked work

Documented in [external-blockers.md](./external-blockers.md):

- M1.7 upstream baseline (unshipped `llama-helper`, build-time downloads, Bazel absent).
- M5.4 native LiteRT-LM worker compilation (Bazel + multi-GB upstream tree).
- Model weights (not vendored; every catalog digest is pinned).
- System-audio Windows runtime verification (the WASAPI backend compiles and lints for the
  Windows target but has not run on a Windows host here), diarization, mobile capture
  plumbing, cross-platform screenshot backends, OCR, and distribution signing.

## Reproduce

```bash
pnpm install
pnpm brand:check
pnpm test
pnpm typecheck
pnpm build
pnpm tauri:dev
```

For a rebrand, see [rebranding.md](./rebranding.md); for the offline guarantee, see
[offline-policy.md](./offline-policy.md).
