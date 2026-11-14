# Mobile audio

Use Memo's capture, WAV, ASR, and diarization layers are portable Rust. Mobile builds add
a thin native layer for microphone consent and the platform audio session. This page
separates what is implemented from what has actually been compiled and run.

## Status

- **Implemented:** the first-party `crates/memo-mobile-audio` Tauri plugin, a generated
  `Info.ios.plist`, and the recording-dialog consent/session flow.
- **Verified here:** the plugin's Rust wire models and desktop no-op (5 tests), TypeScript
  typecheck, `swiftc -parse` on the Swift source, `plutil -lint` on the plist, `xmllint`
  on the Android manifest, and the full desktop gate.
- **Not verified here:** native compilation and device capture. This host has no Xcode or
  iPhoneOS SDK; the Android NDK download did not complete; and no Android device or
  emulator is attached. `tauri android init` currently stops at `Android NDK not found`.

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
```

These checks do not compile the Kotlin or Swift plugin code against the real mobile
frameworks. That requires the native projects and toolchains above.

## Remaining blockers

- **iOS:** install Xcode and the iPhoneOS SDK. Command Line Tools alone cannot build the
  Xcode project.
- **Android:** finish an NDK install, set `NDK_HOME`, and provide a device or emulator for
  the runtime check. The NDK download exceeded this session's limit.
- **Runtime behavior:** consent dialogs, audio-session interruption/resumption, Bluetooth
  routing, and background recording still need a device acceptance pass.

See [acceptance.md](./acceptance.md#m813--mobile-permissions-and-audio-sessions) and
[external-blockers.md](./external-blockers.md#mobile-capture).
