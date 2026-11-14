# Acceptance and verification

Every milestone item has a reproducible check. The full gate is:

```bash
pnpm brand:check
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm test` expands to `pnpm brand:test && pnpm package:test && pnpm airgap:test && pnpm test:rust`.

## Expected totals

| Suite | Tests | Proves |
| --- | --- | --- |
| Brand codegen (`scripts/apply-brand.test.ts`) | 15 | Manifest validation, overlay merge, Tauri/capability output, generated macOS/iOS plists, microphone entitlements, tokens, deterministic artifacts, assets |
| Packaging (`scripts/package-release.test.ts`) | 8 | Artifact discovery/staging, normalized names, SHA-256 output, manifest ordering, bundle lookup, timestamps |
| Air gap (`scripts/airgap.test.ts`) | 5 | No cloud SDK/endpoints, only allowlisted hosts, strict CSP, no browser network primitives |
| `memo-audio-capture` | 41 | Ring buffers, mixing, resampling, downmix, level metering, WAV writer/reader, PCM formats |
| `memo-litert-bridge` | 8 | Framing, size cap, request/response serde, worker timeout/error paths |
| `memo-diarize` | 18 | VAD regions and fragment merging, MFCC finiteness, k-means separation, duration floors, turn alignment |
| `memo-mobile-audio` | 5 | Permission/session wire models, native response parsing, desktop no-op behavior |
| Tauri host | 101 | Storage/FTS, transactional transcript replacement, verifier, parser, export, screenshot policy, models, brand, events, sidecar, dual-channel session, speaker labels |
| Screenshot/vault acceptance | 1 | Synthetic 35 s session, dedup, WebP export, relative assets, Markdown frontmatter |
| ASR acceptance | 1 gated | Real whisper.cpp inference over known speech; skips unless a model and WAV are supplied |
| System-audio acceptance | 1 gated | Real ScreenCaptureKit loopback over a played tone; skips unless enabled and granted |
| Diarization acceptance | 1 gated | Real ScreenCaptureKit capture of two synthesized voices, then VAD/embedding/clustering; skips unless enabled and granted |

The ASR test is compiled but returns early without `MEMO_ASR_E2E=1`, so the default suite
stays offline and fast. The system-audio and diarization tests behave the same without
`MEMO_SYSTEM_AUDIO_E2E=1` and `MEMO_DIARIZATION_E2E=1`.

The host was recorded as an Apple M1 Pro / 16 GB / macOS 27.2 / Rust 1.100.0. See
`build-env.json`.

## M7.1 — Air-gapped guard

```bash
pnpm airgap:test
```

Checks:

1. Source roots were actually scanned (>100 files).
2. No forbidden cloud/analytics/telemetry strings.
3. Only allowlisted URL hosts appear.
4. CSP `connect-src` has no wildcard or remote origin.
5. UI code contains no `fetch`, `XMLHttpRequest`, WebSocket, or `sendBeacon`.

Details: [offline-policy.md](./offline-policy.md).

## M7.2 — Hallucination acceptance

```bash
cargo test -p use-memo synthesis::verifier::tests::acceptance_check_invented_owner_and_deadline_are_deterministically_replaced
```

The fixture invents `"Bob"` as an owner and `"Next Friday"` as a deadline with no matching
transcript/note evidence. The verifier must force `Unassigned` and `Not specified` and
report both substitutions. Additional verifier tests cover:

- Items with no valid evidence are discarded.
- Invalid refs are stripped while valid refs keep the item.
- Screenshot-only evidence cannot ground owners/deadlines.
- Adjacent transcript segments can ground a deadline.
- Placeholder normalization (`@`, empty, `TBD`).
- Non-action items never carry owner/deadline.

## M7.3 — White-label acceptance

```bash
pnpm brand:test
```

The secondary profile `clinical-scribe-offline` must produce:

- `ClinicalScribe Offline` product name and `clinical-scribe-offline` binary.
- `org.clinicalscribe.offline` bundle ID and `clinicalscribe` deep-link scheme.
- `clinical_scribe_vault.db` and `clinical-scribe-offline` storage root.
- Light default theme with the overridden accent tokens.
- `gemma-4-E4B-it-litert-lm` as the SLM repository.

The test also proves the default brand remains unchanged and that generated outputs are
deterministic. Restore with `pnpm brand:apply`.

## M7.4 — Screenshot/vault acceptance

```bash
cargo test -p use-memo --test screenshot_vault_acceptance
```

The test drives a synthetic 35-second meeting at a 10-second interval:

- Captures frames as a slide changes each 10 s.
- Suppresses an unchanged manual snap at 25 s as a duplicate.
- Encodes accepted frames to WebP.
- Exports a Markdown vault with YAML frontmatter.
- Copies four images and links them with relative `assets/` paths.
- Reports missing images without aborting the export.

## On-device ASR acceptance

```bash
MEMO_ASR_E2E=1 \
MEMO_ASR_MODEL=/path/to/ggml-small-q5_1.bin \
MEMO_ASR_WAV=/path/to/speech-16k.wav \
cargo test -p use-memo --test asr_acceptance -- --nocapture
```

Generate a deterministic sample on macOS:

```bash
say -o /tmp/asr-sample.wav --data-format=LEI16@16000 \
  "The quarterly launch review starts on Monday. We decided to delay the beta by two weeks."
```

Recorded result on the host with `ggml-small-q5_1.bin`
(`sha256 ae85e4a9…11bb`, 190,085,487 bytes):

```text
ASR transcript: The quarterly launch review starts on Monday, we decided to delay the beta by two weeks.
test whisper_transcribes_known_speech_with_timestamps ... ok
```

The test asserts the expected words and at least one positive timestamp range. It does not
assert exact punctuation, because decoder punctuation is model-dependent.

## System-audio loopback acceptance

```bash
MEMO_SYSTEM_AUDIO_E2E=1 \
cargo test -p use-memo --test system_audio_acceptance -- --nocapture
```

The test writes a four-second 440 Hz tone, opens ScreenCaptureKit first, plays the tone
through the normal output device with `afplay`, and fails unless at least one block arrives
with a peak above `0.01`. It skips with instructions when the process lacks Screen
Recording permission, and it skips if `afplay` is unavailable. The machine must not be
muted; loopback capture is post-mix.

This test proves the macOS backend end to end. It now passes on the recorded host after
Screen Recording was granted:

```text
test loopback_captures_playback ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.60s
```

On a host without the grant the harness still reports the denial as a skip with
instructions, never as fake audio.

The WASAPI backend cannot be executed on macOS, but its API usage is checked without a
Windows machine:

```bash
rustup target add x86_64-pc-windows-msvc
bash scripts/check-windows-backend.sh
```

The script compiles and lints `audio/system/windows.rs` against `wasapi` 0.27 with a stub
error type. That is a compile check, not capture; the backend has not run on a Windows host
in this repository's recorded environment, so its status is "compiles, not tested here".

## Channel merge checks

The unit suite proves the parts that do not need a device:

- `audio::session::tests::take_duration_covers_a_late_system_archive` keeps a system tap
  that starts after the microphone on the shared clock.
- `audio::session::tests::system_failure_is_a_fact_not_a_lost_microphone_take` checks that a
  loopback error is reported without discarding the microphone outcome.
- `asr::transcribe::tests::channels_merge_on_one_timeline_and_renumber` orders
  `You`/`Them` segments by `startMs` and renumbers `seq_no` across channels.
- `storage::tests::recording_paths_store_microphone_and_system_archives` verifies both paths
  and the offset, and that a microphone-only retake clears a stale system path.

## M8.12 — speaker diarization

```bash
cargo test -p memo-diarize
cargo test -p use-memo asr::transcribe::tests::channel_labels_stay_honest_without_diarization
```

The crate suite covers VAD region merging (including merging sub-second fragments before
the duration floor), short-click rejection, MFCC finiteness and silence energy, k-means
separation of two alternating timbres, the single-voice and duration floors, and
`speaker_at` overlap/nearest-turn alignment. The host test proves the label policy:
microphone is always `You`, the loopback falls back to `Them` without diarization, and a
diarized turn becomes `Speaker 2`.

The real-capture acceptance builds `A, B, A, B` from two macOS voices, plays it through the
normal output device, captures the loopback with ScreenCaptureKit, resamples the archive to
16 kHz, and runs the diarizer:

```bash
MEMO_DIARIZATION_E2E=1 cargo test -p use-memo \
  --test diarization_acceptance -- --nocapture
```

Recorded result on the host:

```text
capture: 417920 samples
diarization: speakers=2 windows=23 speech_ms=20520
turns=[(990, 5490, 1), (6640, 11845, 2), (12520, 17020, 1), (18100, 23885, 2)]
test two_voices_are_separated_from_loopback_audio ... ok
```

The acceptance found a real VAD bug: sub-second speech fragments were discarded before the
merge rule, which erased the quieter voice. Fragments now merge before the duration floor.

Automated evidence:

```text
cargo test -p memo-diarize       18 passed; 0 failed
cargo test (label_for)           ok
```

This is synthesized speech, not a human meeting. A real two-voice recording,
crosstalk/overlap, and music/noise beds remain unverified. Diarization is acoustic
clustering, not voice identification; short or overlapping speech stays `Them`.

## M8.13 — mobile permissions and audio sessions

```bash
cargo test -p memo-mobile-audio
pnpm typecheck
xcrun swiftc -parse crates/memo-mobile-audio/ios/Sources/MobileAudioPlugin.swift
plutil -lint frontend/src-tauri/Info.ios.plist
xmllint --noout crates/memo-mobile-audio/android/src/main/AndroidManifest.xml
```

The plugin tests cover permission/session serialization, the native permission response,
and desktop no-op behavior. The generated plist carries the microphone usage string and
`UIBackgroundModes: audio`; the Android manifest carries `RECORD_AUDIO` and
`MODIFY_AUDIO_SETTINGS`. The recording dialog requests consent and activates the session
before creating the meeting, then releases it after the take.

Recorded evidence on this host:

```text
cargo test -p memo-mobile-audio   5 passed; 0 failed
xcrun swiftc -parse ...           ok
plutil -lint Info.ios.plist       OK
xmllint AndroidManifest.xml       OK
```

Not verified here: native compilation and device capture. The host has no Xcode or
iPhoneOS SDK, the Android NDK install did not finish, and no device/emulator is attached.
`tauri android init` stops at `Android NDK not found`. See [mobile.md](./mobile.md) for the
build steps and the remaining checks.

## M4.6 / M5 / M6 — host and UI gates

```bash
pnpm typecheck
pnpm build
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm build` must emit 12 static pages: dashboard, HUD, Model Studio, three meeting studios,
three synthesis canvases, 404, and the root layout assets.

## M8.14 — packaging and signing

```bash
pnpm package:release -- --skip-build
```

Local build evidence (macOS 27.2, arm64):

```text
Built application at: target/release/use-memo
Bundling Use Memo.app
Signing with identity "-"
Finished 2 bundles at:
    target/release/bundle/macos/Use Memo.app (8.42 MiB)
    target/release/bundle/dmg/Use Memo_0.1.0_aarch64.dmg (4.54 MiB)

codesign --verify --deep --strict  -> valid on disk / satisfies its Designated Requirement
codesign -d --entitlements         -> com.apple.security.device.audio-input = true
manifests                          -> ad-hoc, not notarized
DMG mount + verify                 -> app inside the image is valid and carries the entitlement
packaged  use-memo_0.1.0_macos_arm64.dmg (4,758,162 bytes)
sha256    3d005737e6e94c9bdb555159b504115d339f821c32e38c0c0ca108450da7ebb6
shasum -a 256 -c SHA256SUMS.txt    -> OK
spctl --assess                     -> rejected (expected: no Developer ID / notarization)
launch/quit                        -> packaged app started and exited cleanly
```

The generated `tauri.conf.json` sets `signingIdentity: "-"` so a local build is ad-hoc
signed with hardened runtime and the audio-input entitlement. Without this, Tauri skips
signing entirely and the bundle fails `codesign --verify`. `APPLE_SIGNING_IDENTITY`
overrides the config for Developer ID builds.

Notarization is **not verified**: this host only has an Apple Development certificate.
`spctl --assess` rejects the ad-hoc app, which is expected. See
[packaging.md](./packaging.md) for the Developer ID and notarization commands.

## Manual native smoke test

Run `pnpm tauri:dev` and verify:

1. The window title and icon match the active brand.
2. The HUD opens as a separate always-on-top window and reflects recording status.
3. "New recording" creates a meeting, starts a session, counts up, and stops cleanly.
   Stopping writes `media/<meeting>/audio.wav` and a `recording:stopped` event with the
   sample-clock duration. When **System audio** is enabled on a supported host, the same
   take also writes `media/<meeting>/audio-system.wav`, and the dialog shows a live meter
   for both channels. Play something audible and use headphones so the microphone does not
   re-record the speakers.
4. **Local recordings** on the dashboard lists the take, shows its status/duration, and
   enables Transcribe only when audio exists. Transcribing shows real percent progress,
   writes segments through one transaction, and renders timestamps and speaker labels.
   With loopback enabled, remote segments are labelled `Them` and are interleaved with the
   `You` microphone segments on one clock. If the microphone was denied, the take is
   reported silent and no text is invented; a silent system archive is reported separately.
5. A screenshot appears after the interval or manual capture; an unchanged screen is
   deduplicated.
6. Synthesis reports progress stages and a verification report. Without the native worker
   it fails closed with a clear message and never calls a remote model.
7. Model Studio lists hardware, artifacts, and install state; download progress updates.
8. Search returns highlighted snippets; renaming a speaker updates results.
9. Export writes `index.md` plus relative WebP assets under the brand data directory.

## Browser fallback test

Run `pnpm dev` and verify that every view renders with the demo vault and that no request
leaves the origin. Commands resolve to `null`; the UI keeps local state instead of showing
transport errors.

## Formatting and generated-file rules

- Prettier ignores generated Tauri config/capabilities and brand outputs so codegen stays
  byte-deterministic.
- `pnpm brand:check` must be clean before committing.
- `cargo fmt --all -- --check` is part of `pnpm format:check`.

## Commit audit

Each TODO item is committed separately. Inspect with:

```bash
git log --oneline --decorate
git show --stat <commit>
```

Blocked items (`M1.7`, `M5.4`) are recorded as blocked in `TODO.md`; everything else is
marked `[x]` only after its check passes.
