import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  REPO_ROOT,
  deepMerge,
  encodeIcoFromPngs,
  generateTextFiles,
  isSafeCssValue,
  loadManifest,
  renderBrandTokensCss,
  renderBrandTs,
  renderCapabilities,
  renderGeneratedBrandRs,
  renderInfoIosPlist,
  renderInfoPlist,
  renderTauriConfig,
  validateManifest,
  type BrandManifest,
} from "./apply-brand.ts";

const base = loadManifest();
const profile = loadManifest({ profile: "clinical-scribe-offline" });

test("base manifest is valid and branded for the default product", () => {
  assert.deepEqual(validateManifest(base), []);
  assert.equal(base.brandId, "use-memo");
  assert.equal(base.productName, "UseMemo");
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
  assert.equal(profile.modelRegistry.defaultSlmRepo, "bartowski/google_gemma-3-4b-it-GGUF");
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
      security: {
        csp: string;
        devCsp: string;
        assetProtocol: { enable: boolean; scope: string[] };
      };
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
  assert.equal(hud.url, "/hud/");
  assert.equal(hud.alwaysOnTop, true);
  assert.equal(hud.transparent, true);
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.doesNotMatch(config.app.security.csp, /localhost:3000/);
  assert.match(config.app.security.devCsp, /localhost:3000/);
  assert.ok(
    config.app.security.assetProtocol.scope.includes("$DATA/clinical-scribe-offline/media/**"),
  );
  assert.ok(!config.app.security.assetProtocol.scope.includes("$TEMP/**"));
  assert.ok(config.bundle.icon.includes("icons/icon.icns"));
  assert.ok(config.bundle.resources.includes("resources/brand.config.json"));
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["clinicalscribe"]);
});

test("macOS bundle declares the microphone entitlement and usage string", () => {
  const config = JSON.parse(renderTauriConfig(base, "0.1.0")) as {
    bundle: {
      macOS: {
        entitlements?: string;
        minimumSystemVersion?: string;
        signingIdentity?: string;
        hardenedRuntime?: boolean;
      };
    };
  };
  assert.equal(config.bundle.macOS.entitlements, "entitlements.plist");
  assert.equal(config.bundle.macOS.signingIdentity, "-");
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.ok(config.bundle.macOS.minimumSystemVersion);

  const info = renderInfoPlist(base);
  assert.match(info, /NSMicrophoneUsageDescription/);
  assert.match(info, /Nothing is uploaded/);
  assert.match(info, /UseMemo records meeting audio/);
  assert.match(info, /NSHumanReadableCopyright/);
  // The generated file on disk must match the manifest so `brand:check` catches
  // a hand-edited plist that would leak the reference brand.
  assert.equal(fs.readFileSync(`${REPO_ROOT}/frontend/src-tauri/Info.plist`, "utf8"), info);

  const entitlements = fs.readFileSync(
    `${REPO_ROOT}/frontend/src-tauri/entitlements.plist`,
    "utf8",
  );
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /<true\/>/);
});

test("macOS plist follows a rebrand and escapes XML", () => {
  const rebranded = structuredClone(profile) as BrandManifest;
  rebranded.productName = "Clinical & Co <Offline>";
  const info = renderInfoPlist(rebranded);
  assert.match(info, /Clinical &amp; Co &lt;Offline&gt; records meeting audio/);
  assert.doesNotMatch(info, /UseMemo/);
  assert.match(info, /© \d{4} ClinicalScribe Local Cooperative/);
});

test("iOS bundle declares the microphone usage string and background audio", () => {
  const config = JSON.parse(renderTauriConfig(base, "0.1.0")) as {
    bundle: { iOS?: { infoPlist?: string; minimumSystemVersion?: string } };
  };
  assert.equal(config.bundle.iOS?.infoPlist, "Info.ios.plist");
  assert.equal(config.bundle.iOS?.minimumSystemVersion, "15.0");

  const info = renderInfoIosPlist(base);
  assert.match(info, /NSMicrophoneUsageDescription/);
  assert.match(info, /UseMemo records meeting audio on this device/);
  assert.match(info, /Nothing is uploaded/);
  assert.match(info, /UIBackgroundModes/);
  assert.match(info, /<string>audio<\/string>/);
  assert.match(info, /NSHumanReadableCopyright/);
  assert.equal(
    fs.readFileSync(`${REPO_ROOT}/frontend/src-tauri/Info.ios.plist`, "utf8"),
    info,
  );
});

test("iOS plist follows a rebrand and escapes XML", () => {
  const rebranded = structuredClone(profile) as BrandManifest;
  rebranded.productName = "Clinical & Co <Mobile>";
  const info = renderInfoIosPlist(rebranded);
  assert.match(info, /Clinical &amp; Co &lt;Mobile&gt; records meeting audio on this device/);
  assert.doesNotMatch(info, /UseMemo/);
  assert.match(info, /© \d{4} ClinicalScribe Local Cooperative/);
});

test("brand token CSS uses OKLCH values and Tailwind v4 theme mappings", () => {
  const css = renderBrandTokensCss(profile);
  assert.match(css, /--brand-accent-primary: oklch\(0\.48 0\.13 200\)/);
  assert.match(css, /--brand-bg-primary: oklch\(0\.99 0\.004 220\)/);
  assert.match(css, /@theme inline/);
  assert.match(css, /--color-accent-primary: var\(--brand-accent-primary\)/);
  assert.match(css, /--font-sans: var\(--brand-font-sans\)/);
  assert.doesNotMatch(css, /UseMemo/);
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
  assert.match(capabilities, /core:window:allow-start-dragging/);
  assert.match(capabilities, /deep-link:default/);
  assert.match(capabilities, /memo-mobile-audio:default/);
});

test("codegen emits every required artifact", () => {
  const files = generateTextFiles(profile).map((file) => file.relativePath);
  assert.deepEqual(files, [
    "frontend/src-tauri/tauri.conf.json",
    "frontend/src-tauri/tauri.android.conf.json",
    "frontend/src-tauri/tauri.ios.conf.json",
    "frontend/src-tauri/Info.plist",
    "frontend/src-tauri/Info.ios.plist",
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

test("CSS value validator blocks rule-breakout and external url() injection", () => {
  assert.equal(isSafeCssValue("oklch(0.72 0.16 165)"), true);
  assert.equal(isSafeCssValue("Inter, system-ui, sans-serif"), true);
  assert.equal(isSafeCssValue("red; } body { background: url(https://example.com/bg.png) }"), false);
  assert.equal(isSafeCssValue("@import 'https://example.com/x.css'"), false);

  const injected = structuredClone(base) as BrandManifest;
  injected.theme.tokens.dark.accentPrimary = "red; } * { display: none";
  const errors = validateManifest(injected);
  assert.ok(errors.some((e) => e.includes("unsafe CSS")));
});

test("pure-TS ICO encoder writes valid ICONDIR header and directory entries", () => {
  const fakePng16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const fakePng256 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8, 9, 10]);
  const ico = encodeIcoFromPngs([
    { size: 16, png: fakePng16 },
    { size: 256, png: fakePng256 },
  ]);
  assert.equal(ico.readUInt16LE(0), 0); // Reserved
  assert.equal(ico.readUInt16LE(2), 1); // Type = ICO
  assert.equal(ico.readUInt16LE(4), 2); // 2 frames
  assert.equal(ico.readUInt8(6), 16); // First frame width = 16
  assert.equal(ico.readUInt8(6 + 16), 0); // Second frame width = 0 (256px)
  assert.equal(ico.length, 6 + 32 + fakePng16.length + fakePng256.length);
});

test("clinical-scribe-offline profile defines Clinical SOAP synthesisTemplate", () => {
  assert.equal(profile.synthesisTemplate?.name, "Clinical SOAP Note");
  assert.deepEqual(
    profile.synthesisTemplate?.sections.map((s) => s.key),
    ["subjective", "objective", "assessment", "plan"],
  );
});
