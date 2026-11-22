# Mobile audio

UseMemo's capture, WAV, ASR, and diarization layers are portable Rust. Mobile builds add
a thin native layer for microphone consent and the platform audio session. This page
separates what is implemented from what has actually been compiled and run.

## Status

- **Implemented:** the first-party `crates/memo-mobile-audio` Tauri plugin, a generated
  `Info.ios.plist`, and the recording-dialog consent/session flow.
- **Verified here:** the plugin's Rust wire models and desktop no-op (5 tests), TypeScript
  typecheck, `swiftc -parse` on the Swift source, `plutil -lint` on the plist, `xmllint`
  on the Android manifest, and the full desktop gate. The Android arm64 debug APK was also
  compiled and run on an API 36 emulator: the native microphone prompt, transient-exclusive
  audio focus, capture start, WAV/SQLite finalization, and focus release all completed.
- **Not verified here:** iOS native compilation/runtime, a physical Android device, audible
  microphone input (the emulator input was near-silence), Bluetooth/interruption/background
  recording, and ASR in the Android test APK. The test APK was built with
  `--no-default-features` through a local wrapper to avoid a `whisper-rs-sys` host-BLAS
  cross-compile failure; it intentionally has no speech engine.

## Recording flow

```text
New recording
  ├─ request_microphone_permission   (native consent; desktop reports granted)
  ├─ configure_audio_session         (iOS AVAudioSession / Android audio focus)
  ├─ create_meeting
  ├─ start_recording                 (existing cpal capture session)
  └─ stop_recording
       └─ deactivate_audio_session   (release session/focus, even on failure)
```

A denied microphone prompt aborts before the meeting row is created, so a refusal cannot
leave an empty take in the vault.

## Platform behavior

### Android

- The plugin manifest declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, and marks the
  microphone feature optional so the app still installs on devices without one.
- Consent uses Tauri's native permission alias (`microphone`); the command maps
  `PermissionState` to `granted` / `denied` / `prompt`.
- The session requests transient-exclusive audio focus so other playback does not bleed
  into the microphone. Focus is advisory: capture still proceeds if the request is denied.
- The Android build is configured for a single `main` WebView via
  `frontend/src-tauri/tauri.android.conf.json`. The desktop `main` + `hud` list created a
  second WebView on Android and broke native IPC callback delivery.
- Android app UIDs have no passwd/HOME entry, so startup seeds `XDG_DATA_HOME` and
  `XDG_CACHE_HOME` from Tauri's app directories before storage initializes.
- Android capture is microphone-only. System-audio loopback and automatic screenshots
  return typed not-implemented errors; the take continues without them.
- `deactivate_audio_session` abandons the focus request.

### iOS

- `Info.ios.plist` is generated from the brand manifest with
  `NSMicrophoneUsageDescription` and `UIBackgroundModes: audio`, so the prompt has the
  required purpose string and a take can continue while the screen is locked.
- Consent uses `AVAudioApplication.requestRecordPermission` on iOS 17+ and
  `AVAudioSession.requestRecordPermission` on earlier versions.
- The session uses the `.playAndRecord` category with `.allowBluetooth` and
  `.defaultToSpeaker`, activates it before capture, and releases it with
  `.notifyOthersOnDeactivation` afterward.
- Requires deployment target iOS 15 or newer.

### Desktop

The plugin is a no-op: the capture backend prompts directly, and no session needs to be
activated. The same commands keep the UI platform-neutral.

## Building the native projects

Generated projects live under `frontend/src-tauri/gen/` and are gitignored; rerun the
relevant `init` after changing the brand or plugin. Both commands use the Tauri CLI already
installed in `frontend/`.

### Android

Prerequisites: JDK 17, Android SDK platform/build-tools, an NDK (r29 or newer is current),
and the Rust Android targets. Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`.

```bash
pnpm --filter @use-memo/frontend tauri android init
pnpm --filter @use-memo/frontend tauri android build --debug
```

`tauri android init` installs the Rust targets unless `--skip-targets-install` is passed.
Install to a device or emulator with:

```bash
pnpm --filter @use-memo/frontend tauri android dev
```

The checked runtime used an arm64 target:

```bash
pnpm --filter @use-memo/frontend tauri android build --debug --apk --target aarch64 --ci
adb install -r frontend/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The arm64 APK was built with NDK 29.0.14206865 and SDK platform 36. The test APK was built
with `--no-default-features` through a local Cargo wrapper because `whisper-rs-sys` selected
a host BLAS library during cross-compilation; it therefore has no ASR. Those build hacks
were local to the verification host and are not committed. A production Android ASR build
still needs that dependency fixed and a checked-in build recipe.

### iOS

Prerequisites: full Xcode (not only Command Line Tools), an iOS SDK, and a development
team for signing.

```bash
pnpm --filter @use-memo/frontend tauri ios init
pnpm --filter @use-memo/frontend tauri ios build --debug
```

The generated Xcode project merges `frontend/src-tauri/Info.ios.plist`.

## Verification

```bash
cargo test -p memo-mobile-audio
pnpm typecheck
pnpm format:check
xcrun swiftc -parse crates/memo-mobile-audio/ios/Sources/MobileAudioPlugin.swift
plutil -lint frontend/src-tauri/Info.ios.plist
xmllint --noout crates/memo-mobile-audio/android/src/main/AndroidManifest.xml
```

Current evidence:

```text
cargo test -p memo-mobile-audio   5 passed; 0 failed
xcrun swiftc -parse ...           ok
plutil -lint Info.ios.plist       OK
xmllint AndroidManifest.xml       OK
Android arm64 debug APK           built; installed on API 36 arm64-v8a
native permission prompt          WHILE USING THE APP -> RECORD_AUDIO granted
audio focus                       GAIN_TRANSIENT_EXCLUSIVE request -> abandon
capture/finalize                  16 kHz mono WAV; completed SQLite meeting
automatic screenshot              typed not-implemented error; take continued
emulator signal                   99.53% zero samples; peak 8 LSB (near-silence)
```

The emulator run proves the native permission, session, capture, and finalization
plumbing, not audible capture quality. The WAV header was valid (RIFF/WAVE, PCM, mono,
16 kHz, 16-bit) but the input was near-silent.

## Remaining blockers

- **iOS:** the native plugin has not been compiled or run; the host environment is not set
  up with a usable iPhoneOS SDK and signing team.
- **Android:** a physical device with audible microphone input is still required; the
  emulator run was near-silent. Bluetooth routing, interruptions, and background recording
  are also unverified. The test APK has no ASR; see the build note above.
- **Runtime behavior:** audio-session interruption/resumption, Bluetooth routing, and
  background recording still need a device acceptance pass.

See [acceptance.md](./acceptance.md#m813--mobile-permissions-and-audio-sessions) and
[external-blockers.md](./external-blockers.md#mobile-capture).
