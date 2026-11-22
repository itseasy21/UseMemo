# Offline policy

The product promise is: **meeting content, notes, screenshots, search, synthesis, and
exports stay on the device**. The application has no accounts, analytics, telemetry, crash
reporting, remote logging, or cloud inference fallback.

## Runtime network surface

| Host | Purpose | Trigger | Enforcement |
| --- | --- | --- | --- |
| `huggingface.co` | Download a model file from the brand registry | Explicit user action in Model Studio | HTTPS URL from the build-time manifest; declared size and mandatory SHA-256 digest enforced |
| `127.0.0.1` / `localhost` | Local fixture server in downloader tests; Tauri/dev origins | Tests and development only | Not present in production model registry |
| `ipc.localhost`, `asset.localhost` | Tauri IPC and asset protocol | Always (no external egress) | CSP allowlist |
| `json.schemastore.org`, `schema.tauri.app` | JSON schema identifiers in config | Editor/build-time inspection only | Never fetched by the running app |

No other remote host appears in application source. `scripts/airgap.test.ts` enforces this
and rejects unexpected hosts, so adding a new endpoint requires an explicit policy change
and a test update.

## Model downloads

1. The registry provides a repository, filename, declared byte size, and an optional
   SHA-256 digest (mandatory for every catalog file).
2. The downloader builds `https://huggingface.co/<repo>/resolve/main/<filename>?download=true`.
3. It streams to `<filename>.part`, resumes with HTTP Range if a partial exists, and never
   exceeds the declared size.
4. It computes SHA-256, rejects any mismatch, and atomically
   renames the file into `models/`.
5. The UI receives `models:download-progress` events; nothing is fetched in the background.
6. If a download is cancelled or fails, the partial file remains for a later resume.

There is no automatic model update check. Deleting a model removes only that artifact.

## Content Security Policy

The generated CSP is:

```text
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost blob:;
font-src 'self' data:;
connect-src ipc: http://ipc.localhost http://localhost:3000 ws://localhost:3000
```

`connect-src` contains only Tauri IPC and the local development server. There is no `*`,
no remote HTTPS origin, and no analytics endpoint. The air-gap test parses this directive
directly and fails on any unexpected source.

## What the air-gap test checks

`pnpm airgap:test` scans `frontend/src`, `frontend/src-tauri/src`,
`frontend/src-tauri/capabilities`, `crates`, `scripts`, brand config, Tauri config, and
package/Cargo manifests. It fails when it finds:

- Cloud AI SDK or vendor strings (OpenAI, Anthropic, Gemini, etc.).
- Analytics/telemetry/crash SDKs (PostHog, Sentry, Mixpanel, Amplitude, Segment,
  OpenTelemetry, Datadog, New Relic, Firebase, Supabase, Google Analytics, etc.).
- Any `http(s)`/`ws(s)` host outside the allowlist.
- A wildcard or remote origin in `connect-src`.
- `fetch`, `XMLHttpRequest`, `new WebSocket`, or `navigator.sendBeacon` in UI code.

The test itself is excluded from the string scan (it defines the forbidden tokens). The
`example.com` and malformed `http://{address}` test fixtures are also allowlisted. This is
intentional: they never resolve to a real production endpoint.

## Manual audit

```bash
# Every URL literal in application source
rg -o 'https?://[^"'"'"'` )]+' frontend/src frontend/src-tauri/src crates brand scripts

# Network primitives in UI code
rg 'fetch\(|XMLHttpRequest|new WebSocket|sendBeacon' frontend/src

# Telemetry/cloud SDK dependencies
rg -i 'sentry|posthog|mixpanel|amplitude|segment|opentelemetry|datadog|newrelic|openai|anthropic' \
  package.json frontend/package.json frontend/src-tauri/Cargo.toml Cargo.toml crates/*/Cargo.toml
```

Development activity itself is not the runtime air gap: `pnpm install`, `cargo build`, and
the optional model download may use the network. Once dependencies and models are present,
the app runs without it. A fully air-gapped build host should pre-populate the pnpm store,
Cargo registry/cache, and `models/` directory, then build with network disabled.

## Data leaving the machine

None by design. Export is a local filesystem write to `exports/` in the brand data
directory. The app does not include an update checker or a share/upload feature. If a future
feature adds one, it must update this document, the CSP, and the air-gap test in the same
change.
