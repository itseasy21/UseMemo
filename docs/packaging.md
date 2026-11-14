# Packaging and release

M8.14 covers building installable artifacts, signing them where the host allows it, and publishing a
checksum manifest. Everything here is deliberately compatible with the product's offline promise:
the packaging step reads local files, writes local files, and uploads nothing.

## What you get

`pnpm package:release` runs `tauri build` and stages the installers in:

```
dist/release/<version>/<platform>-<arch>/
  <slug>_<version>_<platform>_<arch>.dmg        # macOS
  <slug>_<version>_<platform>_<arch>.exe        # Windows NSIS
  <slug>_<version>_<platform>_<arch>.msi        # Windows MSI
  <slug>_<version>_<platform>_<arch>.deb        # Linux
  <slug>_<version>_<platform>_<arch>.AppImage   # Linux
  <slug>_<version>_<platform>_<arch>.rpm        # Linux
  SHA256SUMS.txt
  release-manifest.json
```

The Tauri build output remains in `target/release/bundle/`. The `.app` directory there is the quickest
way to launch a local build; the DMG is what you hand to a tester.

`release-manifest.json` records the brand, version, bundle identifier, license, platform, architecture,
git commit, dirty-tree flag, build timestamp, signature/notarization status, and each artifact's size
and SHA-256. Set `SOURCE_DATE_EPOCH` to freeze the timestamp for reproducible manifests.

## Prerequisites

- Node.js ≥ 20.9 and pnpm 12.11.2 (see `packageManager` in `package.json`).
- Rust 1.90 or newer with the platform toolchain.
- macOS: Xcode command-line tools; macOS 13.0 is the minimum deployment target.
- Windows: Visual Studio Build Tools with the C++ workload, plus WebView2 (present on Windows 11).
- Linux: Tauri's WebKitGTK dependencies, for example on Debian/Ubuntu:

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    build-essential curl wget file libssl-dev libayatana-appindicator3-dev
  ```

Whisper and the bundled SQLite compile from source, so the first release build takes substantially
longer than a debug build.

## Build and package

```bash
pnpm brand:check                 # generated brand files must be current
pnpm test                        # JS guards + Rust workspace
pnpm package:release             # build + stage + hash + manifest
pnpm package:release -- --skip-build   # re-stage an existing build
```

The version comes from the root `package.json`. To cut a release:

1. Bump `version` in the root `package.json` (and `frontend/package.json` if you keep them in sync).
2. Run `pnpm brand:apply` so `tauri.conf.json` picks up the new version.
3. Run `pnpm package:release` on each target platform (or use the CI workflow).
4. Verify checksums before distributing:

   ```bash
   shasum -a 256 -c SHA256SUMS.txt     # macOS
   sha256sum -c SHA256SUMS.txt         # Linux
   Get-FileHash -Algorithm SHA256 *    # Windows, compare with the manifest
   ```

Builds are per-platform by design. There is no cross-compilation path for the signed installers.

## macOS: signing, notarization, and Gatekeeper

A build without a signing identity is ad-hoc signed by Tauri. It runs on the machine that built it,
which is enough for local testing, but Gatekeeper will reject it when it arrives over the network.

### Local test build

The generated `tauri.conf.json` pins `signingIdentity` to `"-"`, because Tauri otherwise skips
signing entirely: the bundle fails `codesign --verify`, loses the audio-input entitlement, and
cannot prompt for the microphone. Ad-hoc signing with hardened runtime makes local builds valid
without a certificate. `APPLE_SIGNING_IDENTITY` overrides the config at build time.

```bash
pnpm package:release
open "target/release/bundle/macos/Use Memo.app"
```

The packaging script verifies the signature with `codesign --verify --deep --strict`, confirms the
`com.apple.security.device.audio-input` entitlement, and records whether `spctl` accepts the app.
Ad-hoc builds report `not notarized`; that is expected and does not fail packaging.

### Developer ID signing and notarization

You need a **Developer ID Application** certificate in the login keychain (an Apple Development
certificate is not sufficient for distribution) and either an Apple ID app-specific password or an
App Store Connect API key. Tauri reads these environment variables during `tauri build`:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Example Corp (TEAMID1234)"
export APPLE_ID="release@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID1234"
# or: APPLE_API_KEY, APPLE_API_KEY_PATH, APPLE_API_ISSUER
pnpm package:release -- --require-signature
# after notarization: --require-notarization
```

For CI, `APPLE_CERTIFICATE` (base64-encoded `.p12`) and `APPLE_CERTIFICATE_PASSWORD` import the
certificate before the build. Keep those values in the CI secret store, never in the repository.

`--require-signature` turns the warnings into errors: codesign must verify, the signature must not be
ad-hoc, and the audio-input entitlement must be present. `--require-notarization` additionally
requires `spctl --assess` to accept the app, which is the bar for distributing through Gatekeeper.
Keep in mind that `spctl` records the local Gatekeeper verdict; it is not a substitute for testing
the downloaded DMG on a clean machine.

Tauri staples the notarization ticket to the app when notarization succeeds. If you notarize
manually, staple the DMG as well:

```bash
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "Use Memo_0.1.0_aarch64.dmg"
xcrun notarytool submit "Use Memo.dmg" --keychain-profile memo-release --wait
xcrun stapler staple "Use Memo.dmg"
xcrun stapler validate "Use Memo.dmg"
```

Tauri signs the `.app` inside the image; the outer DMG needs its own signature if you want a
notarized disk image.

### First run and permissions

- Microphone: prompted on the first recording. If it was denied, macOS delivers silence rather than an
  error; reset it with `tccutil reset Microphone org.gnu.usememo`.
- Screen Recording (system audio): prompted the first time the system channel is enabled. Reset with
  `tccutil reset ScreenCapture org.gnu.usememo`, then restart the app.
- Quarantined ad-hoc builds can be opened with right-click → Open, or
  `xattr -dr com.apple.quarantine "/Applications/Use Memo.app"`. Do not document that as the normal
  install path; sign and notarize instead.

The microphone usage string and copyright in `frontend/src-tauri/Info.plist` are generated from
`brand/brand.config.json`. A rebrand cannot leak the reference product's name through the About panel.

## Windows

`bundle.targets = "all"` produces both an NSIS setup executable and an MSI. Sign them with
`signtool` (or configure `bundle.windows.certificateThumbprint` / `signCommand` in `tauri.conf.json`)
before distribution:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a "Use Memo_0.1.0_x64-setup.exe"
```

`pnpm package:release` stages and hashes the installers, but Windows signature verification is not
automated here. Verify manually with `signtool verify /pa /v <file>`.

**Offline installers.** The default `webviewInstallMode` is `downloadBootstrapper`, which fetches the
WebView2 bootstrapper if WebView2 is missing. Windows 11 and current Windows 10 installations normally
already have it. For a strictly air-gapped deployment, switch the generated mode in
`scripts/apply-brand.ts` to:

```json
{ "type": "offlineInstaller" }
```

That embeds the offline WebView2 installer and adds roughly 120 MB to every installer. The system
audio backend compiles and lints for `x86_64-pc-windows-msvc` from macOS, but has not been exercised
on a Windows host; see [external-blockers.md](./external-blockers.md).

## Linux

The AppImage is the portable artifact; the `.deb` and `.rpm` are for managed installs. The AppImage
still relies on the host's WebKitGTK and graphics stack, so test it on the distributions you intend to
support. No signing story is implemented for Linux; publish the checksums alongside the artifacts.

## Updates without a cloud

The Tauri updater plugin is intentionally **not installed** and `createUpdaterArtifacts` stays
`false`. An in-app update check would either contradict the air gap or require an update server that
most deployments do not have.

Update by replacing the installed app with a newer, checksum-verified installer:

1. Ship the new release directory (installer + `SHA256SUMS.txt` + `release-manifest.json`).
2. Verify the checksum and the manifest's version/commit before installing.
3. Install over the previous version. The SQLite vault and recordings live in the per-user app data
   directory, not inside the bundle, and migrations run on start.

If a deployment explicitly wants signed update artifacts, enable the updater plugin, publish the
public key in `tauri.conf.json`, set `createUpdaterArtifacts: true`, and keep `TAURI_SIGNING_PRIVATE_KEY`
offline. That is a deployment decision, not part of the default offline posture.

## CI

`.github/workflows/package.yml` builds on macOS (arm64 and x86_64), Windows, and Linux, runs the
brand/air-gap/package tests plus the Rust workspace tests, and uploads the release directory as a
workflow artifact. Signing secrets are optional: when they are absent the workflow still produces
ad-hoc macOS artifacts and unsigned Windows/Linux installers, which is useful for smoke tests but not
for public distribution.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Tauri bundle found` | `tauri build` has not run, or `CARGO_TARGET_DIR` points elsewhere | run `pnpm tauri:build`, or drop `--skip-build` |
| `No installers found for <platform>` | `bundle.targets` does not cover that platform | restore `"all"` or add the target |
| Microphone records silence | permission denied, or the audio-input entitlement is missing | reset TCC, sign with the entitlement, check `codesign -d --entitlements :-` |
| System audio captures nothing | Screen Recording denied | enable it in System Settings → Privacy & Security, restart the app |
| Gatekeeper blocks the DMG | ad-hoc signature | Developer ID sign and notarize, or right-click → Open for local tests |
| `brand:check` fails after a bump | `tauri.conf.json` still has the old version | run `pnpm brand:apply` |
| `xcrun: error: invalid active developer path` | `xcode-select` points at a missing or incomplete Xcode | finish installing Xcode, or `sudo xcode-select -s /Library/Developer/CommandLineTools` |
| `git` fails inside the packaging script | same broken developer path; git's `/usr/bin` shim uses `xcrun` | fix `xcode-select`, or run with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` |
