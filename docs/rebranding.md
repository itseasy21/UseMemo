# White-label and rebranding

The build is brand-driven. Product strings, identifiers, colors, typography, icons, model
repositories, and feature flags come from one JSON manifest, not from scattered constants.

## Source of truth

```text
brand/brand.config.json              base manifest (default: Use Memo)
brand/profiles/<slug>.json           optional overlay, deep-merged at build time
brand/assets/                        source SVG/PNG assets
brand/generated/brand.resolved.json  committed codegen output
```

A profile may override every field. Nested objects are merged key-by-key; arrays and scalar
values are replaced, not concatenated. Profile filenames are slug-validated and cannot
escape `brand/profiles`.

Preview an overlay:

```bash
pnpm tsx scripts/apply-brand.ts --profile=clinical-scribe-offline
```

Return to the default brand:

```bash
pnpm brand:apply
```

## Manifest fields

| Field | Purpose | Constraint |
| --- | --- | --- |
| `brandId` | Stable internal identifier | lowercase slug |
| `productName` | Window title, metadata, UI strings | non-empty |
| `tagline` | Metadata and shell copy | non-empty |
| `companyName` | Authorship/export frontmatter | non-empty |
| `bundleIdentifier` | macOS bundle ID, Windows identity | reverse-DNS |
| `binaryName` | Binary/bundle executable name | lowercase slug |
| `deepLinkScheme` | Registered URL scheme | lowercase scheme |
| `storageDirName` | Data/cache directory name | safe slug, no separators |
| `sqliteFileName` | Vault database filename | `*.db`, no separators |
| `licenseType` | Export frontmatter and identity | non-empty, expected GPL-3.0-or-later |
| `assets.*` | Icon and wordmark source paths | must exist on disk |
| `theme.defaultMode` | `dark` or `light` at first paint | enum |
| `theme.radius` | Brand radius token | CSS length |
| `theme.fontSans`, `fontMono` | Font stacks | CSS font stack |
| `theme.tokens.dark/light` | OKLCH color tokens | required keys |
| `features.*` | Screenshot/OCR/keybinding/air-gap switches | booleans/integers |
| `modelRegistry.*` | Hugging Face base URL + ASR/SLM/diarization repos | HTTPS HF URL |
| `prompts.*` | Optional synthesis/slide-OCR overrides | strings |

Required color tokens: `bgPrimary`, `bgElevated`, `bgGlass`, `borderSubtle`, `textPrimary`,
`textMuted`, `accentPrimary`, `accentSecondary`, `recordingPulse`.

## Generated outputs

`scripts/apply-brand.ts` writes:

| Output | Consumer |
| --- | --- |
| `frontend/src-tauri/tauri.conf.json` | Tauri identity, windows, CSP, bundle, deep link |
| `frontend/src-tauri/capabilities/default.json` | main/HUD permissions incl. window show/hide/focus |
| `frontend/src-tauri/icons/*` | PNG/ICNS/ICO app and tray icons |
| `frontend/src-tauri/resources/brand.config.json` | embedded runtime manifest |
| `frontend/src-tauri/src/generated_brand.rs` | Rust constants and manifest JSON |
| `frontend/src/generated/brand.ts` | typed frontend manifest and derived constants |
| `frontend/src/styles/brand-tokens.css` | Tailwind v4 `@theme inline` mappings |
| `brand/generated/brand.resolved.json` | committed inspection artifact |

The capability file is generated so a rebrand cannot lose the HUD window permissions. The
generated files are deterministic; `pnpm brand:check` fails if any is stale.

## Runtime override

An enterprise deployment may drop `brand.override.json` into the brand data directory
(shown in the README). Only these top-level keys are merged:

- `productName`
- `tagline`
- `theme`
- `assets`
- `features`
- `prompts`

Everything else is ignored. In particular, `bundleIdentifier`, `binaryName`,
`deepLinkScheme`, `storageDirName`, `sqliteFileName`, `licenseType`, and `modelRegistry`
remain build-time values. The merged manifest is revalidated; malformed JSON, a non-object
payload, or invalid values are rejected at startup.

Tests covering this contract:

- `brand::tests::runtime_override_changes_theme_and_prompts_but_not_identity_or_storage`
- `brand::tests::malformed_override_is_rejected`
- `brand::tests::brand_paths_are_derived_only_from_storage_fields`

## Rebrand checklist

1. Copy or create `brand/profiles/<slug>.json`.
2. Set identity fields, storage names, theme tokens, and model repositories.
3. Replace assets referenced by `assets.*`; keep the tray asset monochrome.
4. Run `pnpm brand:apply --profile=<slug>`.
5. Inspect `brand/generated/brand.resolved.json` and the generated Tauri config.
6. Run `pnpm brand:check` (default profile) and `pnpm brand:test`.
7. Run `pnpm typecheck`, `pnpm build`, and `pnpm test`.
8. Launch `pnpm tauri:dev`; verify title, icon, theme, data path, HUD, and model list.
9. Confirm no product strings were added to source by searching for the old name.
10. Re-run the air-gap test after changing model repositories.

## What codegen does not do

- It does not sign or notarize the bundle.
- It does not upload or publish artifacts.
- It does not compile the LiteRT-LM worker.
- It does not rename existing on-disk data when `storageDirName` changes. Treat a storage
  rename as a new install or migrate the directory explicitly.

## Tests

`pnpm brand:test` verifies:

- Base manifest validity and default identity.
- Overlay merge semantics and slug safety.
- Tauri config identity, HUD window, CSP, icons, and deep-link scheme.
- OKLCH token generation and Tailwind mappings.
- Deterministic TypeScript/Rust/CSS output.
- Capability permissions for the main and HUD windows.
- Existence of every required asset.
- All generated artifacts are emitted.
