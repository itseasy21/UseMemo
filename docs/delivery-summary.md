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
| System audio | macOS ScreenCaptureKit audio-only tap → independent `audio-system.wav`; the gated real-capture acceptance passes on the recorded host. WASAPI backend type-checks for the Windows target, not run here |
| Channel merge | Both archives decoded on one clock; microphone `You`, loopback `Them`; renumbered `seq_no` |
| Speaker diarization | Clean-room VAD + MFCC embeddings + deterministic k-means over the loopback archive; `Speaker N` only when voices separate, `Them` otherwise; CPU-only, no model download |
| Diarization toggle | `meetings.diarization_enabled` (migration 0003), default on; `speakerCount` returned with the transcription outcome |
| Model integrity | `ModelFile.sha256` is mandatory; real Whisper and Gemma digests pinned |
| macOS permission | `NSMicrophoneUsageDescription` + audio-input entitlement generated into the bundle; Screen Recording requested for loopback |
| Mobile permissions | `memo-mobile-audio` Tauri plugin: Android consent/manifest/audio focus and iOS record permission/`AVAudioSession`; generated `Info.ios.plist` with background audio |
| UI | Local recordings panel lists real takes, shows transcripts, and runs transcription with progress; the new-recording dialog probes `audio_capabilities` and meters both channels |
| Honesty | Diarization is acoustic clustering of the loopback, not voice identification; short or overlapping human speech stays `Them`; echo cancellation is explicitly absent; Windows loopback remains unverified. The macOS runtime capture and a two-synthesized-voice diarization acceptance now pass on this host |

Real-model evidence:

```text
ASR transcript: The quarterly launch review starts on Monday, we decided to delay the beta by two weeks.
test whisper_transcribes_known_speech_with_timestamps ... ok
```

## Diarization slice (M8.12)

Diarization runs after the take on the loopback archive only. A dependency-free crate
(`crates/memo-diarize`) performs energy VAD → MFCC mean/std embeddings → deterministic
k-means with separation and minimum-duration gates. The microphone remains `You`; remote
speech becomes `Speaker 1`, `Speaker 2`, … only when the clustering separates it, otherwise
it stays `Them`. The per-meeting toggle is persisted and the outcome reports `speakerCount`.

```text
cargo test -p memo-diarize       18 passed
cargo test (label_for)           microphone You · system Them · diarized Speaker 2
MEMO_DIARIZATION_E2E=1 ...       two synthesized voices → Speaker 1/2 over ScreenCaptureKit
```

The loopback acceptance found and fixed a real VAD bug: sub-second speech fragments were
dropped before the merge rule, which erased a quieter speaker. Fragments now merge before
the duration floor. The tests still use synthesized speech; a real human two-voice meeting,
crosstalk, and music/noise beds are not verified on this host.

## Mobile slice (M8.13)

Mobile builds now have a first-party `memo-mobile-audio` Tauri plugin. The recording dialog
requests consent before creating the meeting, activates the platform session, and releases
it after the take. Android declares `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS`, uses Tauri's
native permission request, and holds transient audio focus. iOS uses
`AVAudioApplication`/`AVAudioSession` consent, a `.playAndRecord` session, and a generated
`Info.ios.plist` with `NSMicrophoneUsageDescription` plus `UIBackgroundModes: audio`.

```text
cargo test -p memo-mobile-audio   5 passed
xcrun swiftc -parse ...           ok
plutil -lint Info.ios.plist       OK
```

The Android arm64 plugin is compiled and the emulator runtime path is verified. A single
`main` WebView (`tauri.android.conf.json`) is required because the desktop HUD window broke
Android IPC callback delivery. With NDK 29.0.14206865 on an API 36 arm64-v8a emulator, the
native `WHILE USING THE APP` consent returned `granted=true`; the dialog reached `capturing`;
Android logged transient-exclusive focus and a `VOICE_RECOGNITION` activity; stopping
produced a completed SQLite meeting and a valid 16 kHz mono WAV; focus was abandoned after
stop. The emulator input was near-silent (99.53% zero samples), so audible capture quality is
not proven. The test APK was built with `--no-default-features` to bypass a
`whisper-rs-sys` host-BLAS cross-compile failure and has no ASR. iOS, physical devices,
Bluetooth/interruption/background behavior, and a production Android ASR build remain
unverified. See [mobile.md](./mobile.md).

## Packaging slice (M8.14)

| Piece | Result |
| --- | --- |
| Branded plist | `Info.plist` is generated from the brand manifest; no reference-brand strings remain in the source template |
| Local signing | Generated config pins `signingIdentity: "-"`, so Tauri ad-hoc signs with hardened runtime and the audio-input entitlement; `APPLE_SIGNING_IDENTITY` overrides it |
| Artifacts | `pnpm package:release` stages normalized installers, `SHA256SUMS.txt`, and `release-manifest.json` with brand/version/commit/arch/hashes |
| macOS evidence | DMG built, mounted, and inspected: `codesign --verify --deep --strict` passes, the audio-input entitlement is present, `shasum -c` passes; `spctl` rejects the ad-hoc app as expected |
| Local artifact | `use-memo_0.1.0_macos_arm64.dmg`, 4,758,162 bytes, SHA-256 `3d005737e6e94c9bdb555159b504115d339f821c32e38c0c0ca108450da7ebb6` (rebuilt after the consumer UI redesign) |
| CI | macOS arm64/x86_64, Windows, and Linux matrix workflow committed; not executed here |
| Updater | In-app updates remain disabled to preserve the air gap; update by replacing the app with a checksum-verified installer |

Notarization is blocked on this host: only an Apple Development certificate is installed, and no
Apple ID or App Store Connect credentials are available. See
[packaging.md](./packaging.md) for the Developer ID path.

## Verification evidence

Final gate run on the recorded host:

```text
pnpm brand:check   Brand outputs are current for Use Memo.
pnpm brand:test    15 passed
pnpm package:test  8 passed
pnpm airgap:test   5 passed
cargo test         41 audio + 8 bridge + 18 diarization + 5 mobile + 101 host + 4 acceptance (3 gated skip by default)
MEMO_SYSTEM_AUDIO_E2E=1 ...  test loopback_captures_playback ... ok
MEMO_DIARIZATION_E2E=1 ...   test two_voices_are_separated_from_loopback_audio ... ok
pnpm typecheck     clean
pnpm build         12 static pages exported
prettier --check   clean
cargo fmt --check  clean
cargo clippy ...   Finished with -D warnings (workspace)
```

That is **205 automated checks** (28 TypeScript/Node, 177 Rust), including one gated ASR
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
  Windows target but has not run on a Windows host here), iOS/physical-device mobile runtime
  (the Android arm64 emulator path is verified), audible microphone quality, a production
  Android ASR build, cross-platform screenshot backends, OCR, and Developer ID notarization
  (the packaging and local-signing path is implemented).

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
