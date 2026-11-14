import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  REPO_ROOT,
  deepMerge,
  generateTextFiles,
  loadManifest,
  renderBrandTokensCss,
  renderBrandTs,
  renderCapabilities,
  renderGeneratedBrandRs,
  renderTauriConfig,
  validateManifest,
  type BrandManifest,
} from "./apply-brand.ts";

const base = loadManifest();
const profile = loadManifest({ profile: "clinical-scribe-offline" });

test("base manifest is valid and branded for the default product", () => {
  assert.deepEqual(validateManifest(base), []);
  assert.equal(base.brandId, "use-memo");
  assert.equal(base.productName, "Use Memo");
  assert.equal(base.bundleIdentifier, "org.gnu.usememo");
  assert.equal(base.theme.defaultMode, "dark");
});

test("profile overlay deep-merges theme and feature maps while replacing scalars", () => {
  assert.equal(profile.brandId, "clinical-scribe-offline");
  assert.equal(profile.productName, "ClinicalScribe Offline");
  assert.equal(profile.theme.defaultMode, "light");
  assert.equal(profile.theme.tokens.light.accentPrimary, "oklch(0.48 0.13 200)");
  // inherited values survive the overlay
  assert.equal(profile.theme.tokens.light.borderSubtle, base.theme.tokens.light.borderSubtle);
  assert.equal(profile.theme.tokens.dark.bgPrimary, base.theme.tokens.dark.bgPrimary);
  assert.equal(profile.theme.tokens.dark.accentSecondary, "oklch(0.64 0.13 300)");
  assert.equal(profile.features.enableGnuKeybindings, false);
  assert.equal(profile.features.airGappedEnforcement, true);
  assert.equal(profile.modelRegistry.defaultSlmRepo, "litert-community/gemma-4-E4B-it-litert-lm");
  assert.equal(profile.modelRegistry.defaultAsrRepo, base.modelRegistry.defaultAsrRepo);
  assert.deepEqual(validateManifest(profile), []);
});

test("deepMerge replaces arrays and primitives instead of concatenating", () => {
  const merged = deepMerge(
    { a: 1, nested: { keep: true, replace: "base" }, list: [1, 2] },
    { nested: { replace: "overlay" }, list: [9] },
  );
  assert.deepEqual(merged, { a: 1, nested: { keep: true, replace: "overlay" }, list: [9] });
});

test("profile slugs cannot escape the profiles directory", () => {
  assert.throws(() => loadManifest({ profile: "../../etc/passwd" }), /Invalid brand profile slug/);
});

test("invalid manifests fail validation with actionable messages", () => {
  const broken = structuredClone(base) as BrandManifest;
  broken.bundleIdentifier = "not a bundle id";
  delete (broken.theme.tokens.dark as Partial<BrandManifest["theme"]["tokens"]["dark"]>).accentPrimary;
  broken.features.defaultScreenshotIntervalSec = 0;
  const errors = validateManifest(broken);
  assert.ok(errors.some((error) => error.includes("bundleIdentifier")));
  assert.ok(errors.some((error) => error.includes("theme.tokens.dark.accentPrimary")));
  assert.ok(errors.some((error) => error.includes("defaultScreenshotIntervalSec")));
});

test("generated Tauri config carries identity, HUD window, CSP, and icons", () => {
  const config = JSON.parse(renderTauriConfig(profile, "9.9.9")) as {
    productName: string;
    identifier: string;
    mainBinaryName: string;
    version: string;
    app: {
      windows: Array<{ label: string; url?: string; alwaysOnTop?: boolean; transparent?: boolean }>;
      security: { csp: string };
    };
    bundle: { icon: string[]; resources: string[] };
    plugins: { "deep-link": { desktop: { schemes: string[] } } };
  };
  assert.equal(config.productName, "ClinicalScribe Offline");
  assert.equal(config.identifier, "org.clinicalscribe.offline");
  assert.equal(config.mainBinaryName, "clinical-scribe-offline");
  assert.equal(config.version, "9.9.9");
  const hud = config.app.windows.find((window) => window.label === "hud");
  assert.ok(hud);
  assert.equal(hud.url, "/hud");
  assert.equal(hud.alwaysOnTop, true);
  assert.equal(hud.transparent, true);
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.ok(config.bundle.icon.includes("icons/icon.icns"));
  assert.ok(config.bundle.resources.includes("resources/brand.config.json"));
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["clinicalscribe"]);
});

test("brand token CSS uses OKLCH values and Tailwind v4 theme mappings", () => {
  const css = renderBrandTokensCss(profile);
  assert.match(css, /--brand-accent-primary: oklch\(0\.48 0\.13 200\)/);
  assert.match(css, /--brand-bg-primary: oklch\(0\.99 0\.004 220\)/);
  assert.match(css, /@theme inline/);
  assert.match(css, /--color-accent-primary: var\(--brand-accent-primary\)/);
  assert.match(css, /--font-sans: var\(--brand-font-sans\)/);
  assert.doesNotMatch(css, /Use Memo/);
});

test("TypeScript and Rust brand outputs are deterministic and embedded", () => {
  const tsA = renderBrandTs(profile);
  const tsB = renderBrandTs(profile);
  assert.equal(tsA, tsB);
  assert.match(tsA, /"productName": "ClinicalScribe Offline"/);
  assert.match(tsA, /"sqliteFileName": "clinical_scribe_vault.db"/);
  assert.match(tsA, /export const PRODUCT_NAME = BRAND\.productName/);
  assert.match(tsA, /export const DEFAULT_THEME_MODE: ThemeMode = BRAND\.theme\.defaultMode/);

  const rs = renderGeneratedBrandRs(profile);
  assert.match(rs, /pub const PRODUCT_NAME: &str = "ClinicalScribe Offline";/);
  assert.match(rs, /pub const DEFAULT_SCREENSHOT_INTERVAL_SEC: u32 = 10;/);
  assert.match(rs, /include_str!\("\.\.\/resources\/brand\.config\.json"\)/);
  assert.match(rs, /\("accentPrimary", "oklch\(0\.48 0\.13 200\)"\)/);
});

test("capabilities cover both windows and the HUD reveal controls", () => {
  const capabilities = renderCapabilities(profile);
  assert.match(capabilities, /"windows": \[[\s\S]*"main"[\s\S]*"hud"[\s\S]*\]/);
  assert.match(capabilities, /core:window:allow-show/);
  assert.match(capabilities, /core:window:allow-hide/);
  assert.match(capabilities, /core:window:allow-set-focus/);
});

test("codegen emits every required artifact", () => {
  const files = generateTextFiles(profile).map((file) => file.relativePath);
  assert.deepEqual(files, [
    "frontend/src-tauri/tauri.conf.json",
    "frontend/src-tauri/capabilities/default.json",
    "frontend/src-tauri/resources/brand.config.json",
    "frontend/src-tauri/src/generated_brand.rs",
    "frontend/src/generated/brand.ts",
    "frontend/src/styles/brand-tokens.css",
    "brand/generated/brand.resolved.json",
  ]);
});

test("all required brand assets exist on disk", () => {
  for (const assetPath of Object.values(base.assets)) {
    assert.ok(fs.existsSync(`${REPO_ROOT}/${assetPath}`), `missing asset: ${assetPath}`);
  }
});
