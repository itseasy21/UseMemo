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

`pnpm test` expands to `pnpm brand:test && pnpm airgap:test && pnpm test:rust`.

## Expected totals

| Suite | Tests | Proves |
| --- | --- | --- |
| Brand codegen (`scripts/apply-brand.test.ts`) | 11 | Manifest validation, overlay merge, Tauri/capability output, tokens, deterministic artifacts, assets |
| Air gap (`scripts/airgap.test.ts`) | 5 | No cloud SDK/endpoints, only allowlisted hosts, strict CSP, no browser network primitives |
| `memo-audio-capture` | 25 | Ring buffers, mixing, resampling, downmix, level metering, format handling |
| `memo-litert-bridge` | 8 | Framing, size cap, request/response serde, worker timeout/error paths |
| Tauri host | 80 | Storage/FTS, verifier, parser, export, screenshot policy, models, brand, events, sidecar |
| Screenshot/vault acceptance | 1 | Synthetic 35 s session, dedup, WebP export, relative assets, Markdown frontmatter |

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

## M4.6 / M5 / M6 — host and UI gates

```bash
pnpm typecheck
pnpm build
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm build` must emit 12 static pages: dashboard, HUD, Model Studio, three meeting studios,
three synthesis canvases, 404, and the root layout assets.

## Manual native smoke test

Run `pnpm tauri:dev` and verify:

1. The window title and icon match the active brand.
2. The HUD opens as a separate always-on-top window and reflects recording status.
3. "New recording" creates a meeting, starts a session, counts up, and stops cleanly.
4. A screenshot appears after the interval or manual capture; an unchanged screen is
   deduplicated.
5. Synthesis reports progress stages and a verification report. Without the native worker
   it fails closed with a clear message and never calls a remote model.
6. Model Studio lists hardware, artifacts, and install state; download progress updates.
7. Search returns highlighted snippets; renaming a speaker updates results.
8. Export writes `index.md` plus relative WebP assets under the brand data directory.

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
