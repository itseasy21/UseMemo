/**
 * White-label build-time code generator.
 *
 * Single source of truth: brand/brand.config.json (+ optional profile overlay).
 * Outputs:
 *   - frontend/src-tauri/tauri.conf.json
 *   - frontend/src-tauri/capabilities/default.json
 *   - frontend/src-tauri/resources/brand.config.json
 *   - frontend/src-tauri/src/generated_brand.rs
 *   - frontend/src/generated/brand.ts
 *   - frontend/src/styles/brand-tokens.css
 *   - frontend/src-tauri/icons/* (via the Tauri icon pipeline, with a sharp fallback)
 *   - brand/generated/brand.resolved.json
 *
 * Usage:
 *   pnpm brand:apply
 *   pnpm brand:apply --profile=clinical-scribe-offline
 *   pnpm brand:check
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface ThemeTokens {
  bgPrimary: string;
  bgElevated: string;
  bgGlass: string;
  borderSubtle: string;
  textPrimary: string;
  textMuted: string;
  accentPrimary: string;
  accentSecondary: string;
  recordingPulse: string;
}

export interface BrandManifest {
  $schema?: string;
  brandId: string;
  productName: string;
  tagline: string;
  companyName: string;
  bundleIdentifier: string;
  binaryName: string;
  deepLinkScheme: string;
  storageDirName: string;
  sqliteFileName: string;
  licenseType: string;
  assets: {
    appIconSvg: string;
    trayIconMonochrome: string;
    wordmarkDark: string;
    wordmarkLight: string;
  };
  theme: {
    defaultMode: "dark" | "light";
    radius: string;
    fontSans: string;
    fontMono: string;
    tokens: { dark: ThemeTokens; light: ThemeTokens };
  };
  features: {
    airGappedEnforcement: boolean;
    enablePeriodicScreenshots: boolean;
    defaultScreenshotIntervalSec: number;
    enableSlideVisionOCR: boolean;
    enableVoiceprintEnrollment: boolean;
    enableGnuKeybindings: boolean;
  };
  modelRegistry: {
    hfBaseUrl: string;
    defaultAsrRepo: string;
    fallbackAsrRepo: string;
    diarizationRepo: string;
    defaultSlmRepo: string;
    proSlmRepo: string;
  };
}

const TOKEN_KEYS: Array<keyof ThemeTokens> = [
  "bgPrimary",
  "bgElevated",
  "bgGlass",
  "borderSubtle",
  "textPrimary",
  "textMuted",
  "accentPrimary",
  "accentSecondary",
  "recordingPulse",
];

const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where arrays and primitives replace, objects merge recursively. */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return (overlay === undefined ? base : overlay) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

export function loadManifest(options: { profile?: string; root?: string } = {}): BrandManifest {
  const root = options.root ?? REPO_ROOT;
  const basePath = path.join(root, "brand", "brand.config.json");
  const base = JSON.parse(fs.readFileSync(basePath, "utf8")) as BrandManifest;
  if (!options.profile) return base;

  if (!SLUG_RE.test(options.profile)) {
    throw new Error(`Invalid brand profile slug: ${options.profile}`);
  }
  const profilePath = path.join(root, "brand", "profiles", `${options.profile}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Brand profile not found: ${path.relative(root, profilePath)}`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Partial<BrandManifest>;
  return deepMerge(base, profile);
}

export function validateManifest(manifest: BrandManifest, root = REPO_ROOT): string[] {
  const errors: string[] = [];
  const requiredStrings: Array<[string, unknown]> = [
    ["brandId", manifest.brandId],
    ["productName", manifest.productName],
    ["tagline", manifest.tagline],
    ["companyName", manifest.companyName],
    ["bundleIdentifier", manifest.bundleIdentifier],
    ["binaryName", manifest.binaryName],
    ["deepLinkScheme", manifest.deepLinkScheme],
    ["storageDirName", manifest.storageDirName],
    ["sqliteFileName", manifest.sqliteFileName],
    ["licenseType", manifest.licenseType],
  ];
  for (const [label, value] of requiredStrings) {
    if (typeof value !== "string" || value.trim().length === 0) errors.push(`${label} must be a non-empty string`);
  }

  if (!BRAND_ID_RE.test(manifest.brandId ?? "")) {
    errors.push("brandId must be a lowercase slug (a-z, 0-9, hyphen)");
  }
  if (!BUNDLE_ID_RE.test(manifest.bundleIdentifier ?? "")) {
    errors.push("bundleIdentifier must be reverse-DNS (e.g. org.gnu.usememo)");
  }
  if (!BRAND_ID_RE.test(manifest.binaryName ?? "")) {
    errors.push("binaryName must be a lowercase slug");
  }
  if (!/^[a-z][a-z0-9+.-]*$/.test(manifest.deepLinkScheme ?? "")) {
    errors.push("deepLinkScheme must be a lowercase URL scheme");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(manifest.storageDirName ?? "")) {
    errors.push("storageDirName must be a safe directory slug");
  }
  if (!/^[A-Za-z0-9_.-]+\.db$/.test(manifest.sqliteFileName ?? "")) {
    errors.push("sqliteFileName must end in .db and contain no path separators");
  }

  const theme = manifest.theme;
  if (!theme) {
    errors.push("theme is required");
    return errors;
  }
  if (theme.defaultMode !== "dark" && theme.defaultMode !== "light") {
    errors.push("theme.defaultMode must be 'dark' or 'light'");
  }
  for (const field of ["radius", "fontSans", "fontMono"] as const) {
    if (typeof theme[field] !== "string" || !theme[field].trim()) errors.push(`theme.${field} is required`);
  }
  for (const mode of ["dark", "light"] as const) {
    const tokens = theme.tokens?.[mode];
    if (!tokens) {
      errors.push(`theme.tokens.${mode} is required`);
      continue;
    }
    for (const key of TOKEN_KEYS) {
      if (typeof tokens[key] !== "string" || !tokens[key].trim()) {
        errors.push(`theme.tokens.${mode}.${key} is required`);
      }
    }
  }

  const assets = manifest.assets;
  if (!assets) {
    errors.push("assets is required");
  } else {
    for (const key of ["appIconSvg", "trayIconMonochrome", "wordmarkDark", "wordmarkLight"] as const) {
      const assetPath = assets[key];
      if (typeof assetPath !== "string" || !assetPath.trim()) {
        errors.push(`assets.${key} is required`);
        continue;
      }
      const absolute = path.resolve(root, assetPath);
      if (!fs.existsSync(absolute)) errors.push(`assets.${key} does not exist: ${assetPath}`);
    }
  }

  const features = manifest.features;
  if (!features) {
    errors.push("features is required");
  } else {
    for (const key of [
      "airGappedEnforcement",
      "enablePeriodicScreenshots",
      "enableSlideVisionOCR",
      "enableVoiceprintEnrollment",
      "enableGnuKeybindings",
    ] as const) {
      if (typeof features[key] !== "boolean") errors.push(`features.${key} must be a boolean`);
    }
    const interval = features.defaultScreenshotIntervalSec;
    if (!Number.isInteger(interval) || interval < 5 || interval > 3600) {
      errors.push("features.defaultScreenshotIntervalSec must be an integer between 5 and 3600");
    }
  }

  const registry = manifest.modelRegistry;
  if (!registry) {
    errors.push("modelRegistry is required");
  } else {
    for (const key of [
      "hfBaseUrl",
      "defaultAsrRepo",
      "fallbackAsrRepo",
      "diarizationRepo",
      "defaultSlmRepo",
      "proSlmRepo",
    ] as const) {
      if (typeof registry[key] !== "string" || !registry[key].trim()) {
        errors.push(`modelRegistry.${key} is required`);
      }
    }
    if (!/^https:\/\//.test(registry.hfBaseUrl ?? "")) {
      errors.push("modelRegistry.hfBaseUrl must be HTTPS");
    }
  }

  return errors;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rustString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded.includes("\\u")) {
    throw new Error(`Rust codegen does not support non-BMP/escaped characters yet: ${value}`);
  }
  return encoded;
}

export function renderTauriConfig(manifest: BrandManifest, version = "0.1.0"): string {
  const themeName = manifest.theme.defaultMode === "dark" ? "Dark" : "Light";
  const config = {
    $schema: "https://schema.tauri.app/config/2",
    productName: manifest.productName,
    mainBinaryName: manifest.binaryName,
    version,
    identifier: manifest.bundleIdentifier,
    build: {
      beforeDevCommand: "pnpm dev",
      devUrl: "http://localhost:3000",
      beforeBuildCommand: "pnpm build",
      frontendDist: "../out",
    },
    app: {
      withGlobalTauri: false,
      macOSPrivateApi: true,
      windows: [
        {
          label: "main",
          title: manifest.productName,
          width: 1360,
          height: 880,
          minWidth: 1024,
          minHeight: 680,
          center: true,
          resizable: true,
          fullscreen: false,
          visible: true,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          acceptFirstMouse: true,
          theme: themeName,
        },
        {
          label: "hud",
          title: `${manifest.productName} HUD`,
          url: "/hud",
          width: 320,
          height: 48,
          minWidth: 320,
          minHeight: 48,
          maxWidth: 420,
          maxHeight: 280,
          center: false,
          resizable: false,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          visible: false,
          focus: false,
          shadow: true,
        },
      ],
      security: {
        assetProtocol: {
          enable: true,
          scope: ["$APPDATA/**", "$APPLOCALDATA/**", "$APPCACHE/**", "$TEMP/**"],
        },
        csp: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' asset: http://asset.localhost data: blob:",
          "media-src 'self' asset: http://asset.localhost blob:",
          "font-src 'self' data:",
          "connect-src ipc: http://ipc.localhost http://localhost:3000 ws://localhost:3000",
        ].join("; "),
        capabilities: ["default"],
      },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico",
      ],
      resources: ["resources/brand.config.json"],
      category: "Productivity",
      shortDescription: manifest.tagline,
      longDescription: `${manifest.productName} — ${manifest.tagline}. ${manifest.companyName}.`,
      copyright: `© ${new Date().getUTCFullYear()} ${manifest.companyName}`,
      license: manifest.licenseType,
      macOS: {
        minimumSystemVersion: "13.0",
      },
      windows: {
        webviewInstallMode: { type: "downloadBootstrapper", silent: true },
      },
      linux: {
        deb: { depends: [] },
        appimage: { bundleMediaFramework: false },
      },
      createUpdaterArtifacts: false,
    },
    plugins: {
      "deep-link": {
        desktop: { schemes: [manifest.deepLinkScheme] },
      },
    },
  };
  return json(config);
}

export function renderCapabilities(manifest: BrandManifest): string {
  return json({
    $schema: "../gen/schemas/desktop-schema.json",
    identifier: "default",
    description: `Core desktop permissions for ${manifest.productName}`,
    windows: ["main", "hud"],
    permissions: [
      "core:default",
      "core:window:allow-show",
      "core:window:allow-hide",
      "core:window:allow-set-focus",
    ],
  });
}

export function renderBrandTs(manifest: BrandManifest): string {
  const literal = JSON.stringify(manifest, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
  return `// AUTO-GENERATED by scripts/apply-brand.ts — do not edit by hand.
// Source: brand/brand.config.json${manifest.brandId === "use-memo" ? "" : ` + profile ${manifest.brandId}`}
/* eslint-disable */

export const BRAND = ${literal} as const;

export type BrandManifest = typeof BRAND;
export type ThemeMode = keyof BrandManifest["theme"]["tokens"];
export type ThemeTokens = BrandManifest["theme"]["tokens"][ThemeMode];

export const BRAND_ID = BRAND.brandId;
export const PRODUCT_NAME = BRAND.productName;
export const TAGLINE = BRAND.tagline;
export const BUNDLE_IDENTIFIER = BRAND.bundleIdentifier;
export const DEEP_LINK_SCHEME = BRAND.deepLinkScheme;
export const STORAGE_DIR_NAME = BRAND.storageDirName;
export const SQLITE_FILE_NAME = BRAND.sqliteFileName;
export const DEFAULT_THEME_MODE: ThemeMode = BRAND.theme.defaultMode;
export const THEME_TOKEN_KEYS = ${JSON.stringify(TOKEN_KEYS)} as const;

export const THEME_TOKENS: Record<ThemeMode, ThemeTokens> = BRAND.theme.tokens;
export const FEATURES = BRAND.features;
export const MODEL_REGISTRY = BRAND.modelRegistry;
export const BRAND_ASSETS = BRAND.assets;
`;
}

export function renderBrandTokensCss(manifest: BrandManifest): string {
  const varName = (token: string) => `--brand-${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
  const modeBlock = (mode: "dark" | "light") => {
    const tokens = manifest.theme.tokens[mode];
    return [
      ...TOKEN_KEYS.map((key) => `  ${varName(key)}: ${tokens[key]};`),
    ].join("\n");
  };
  const themeMap = [
    ...TOKEN_KEYS.map((key) => `  --color-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: var(${varName(key)});`),
    `  --font-sans: var(--brand-font-sans);`,
    `  --font-mono: var(--brand-font-mono);`,
    `  --radius-brand: var(--brand-radius);`,
  ].join("\n");

  return `/* AUTO-GENERATED by scripts/apply-brand.ts — do not edit by hand. */
/* Brand: ${manifest.productName} (${manifest.brandId}) */

:root {
  color-scheme: light;
  --brand-font-sans: ${manifest.theme.fontSans};
  --brand-font-mono: ${manifest.theme.fontMono};
  --brand-radius: ${manifest.theme.radius};
${modeBlock("light")}
}

.dark {
  color-scheme: dark;
${modeBlock("dark")}
}

@theme inline {
${themeMap}
}
`;
}

export function renderGeneratedBrandRs(manifest: BrandManifest): string {
  const features = manifest.features;
  const tokenTuples = (mode: "dark" | "light") =>
    TOKEN_KEYS.map((key) => `    (${rustString(key)}, ${rustString(manifest.theme.tokens[mode][key])}),`).join("\n");

  return `// AUTO-GENERATED by scripts/apply-brand.ts — do not edit by hand.
#![allow(dead_code)]

pub const BRAND_ID: &str = ${rustString(manifest.brandId)};
pub const PRODUCT_NAME: &str = ${rustString(manifest.productName)};
pub const TAGLINE: &str = ${rustString(manifest.tagline)};
pub const COMPANY_NAME: &str = ${rustString(manifest.companyName)};
pub const BUNDLE_IDENTIFIER: &str = ${rustString(manifest.bundleIdentifier)};
pub const BINARY_NAME: &str = ${rustString(manifest.binaryName)};
pub const DEEP_LINK_SCHEME: &str = ${rustString(manifest.deepLinkScheme)};
pub const STORAGE_DIR_NAME: &str = ${rustString(manifest.storageDirName)};
pub const SQLITE_FILE_NAME: &str = ${rustString(manifest.sqliteFileName)};
pub const LICENSE_TYPE: &str = ${rustString(manifest.licenseType)};

pub const AIR_GAPPED_ENFORCEMENT: bool = ${features.airGappedEnforcement};
pub const ENABLE_PERIODIC_SCREENSHOTS: bool = ${features.enablePeriodicScreenshots};
pub const DEFAULT_SCREENSHOT_INTERVAL_SEC: u32 = ${features.defaultScreenshotIntervalSec};
pub const ENABLE_SLIDE_VISION_OCR: bool = ${features.enableSlideVisionOCR};
pub const ENABLE_VOICEPRINT_ENROLLMENT: bool = ${features.enableVoiceprintEnrollment};
pub const ENABLE_GNU_KEYBINDINGS: bool = ${features.enableGnuKeybindings};

pub const THEME_DEFAULT_MODE: &str = ${rustString(manifest.theme.defaultMode)};
pub const THEME_RADIUS: &str = ${rustString(manifest.theme.radius)};
pub const FONT_SANS: &str = ${rustString(manifest.theme.fontSans)};
pub const FONT_MONO: &str = ${rustString(manifest.theme.fontMono)};

pub const THEME_DARK: &[(&str, &str)] = &[
${tokenTuples("dark")}
];

pub const THEME_LIGHT: &[(&str, &str)] = &[
${tokenTuples("light")}
];

pub const HF_BASE_URL: &str = ${rustString(manifest.modelRegistry.hfBaseUrl)};
pub const DEFAULT_ASR_REPO: &str = ${rustString(manifest.modelRegistry.defaultAsrRepo)};
pub const FALLBACK_ASR_REPO: &str = ${rustString(manifest.modelRegistry.fallbackAsrRepo)};
pub const DIARIZATION_REPO: &str = ${rustString(manifest.modelRegistry.diarizationRepo)};
pub const DEFAULT_SLM_REPO: &str = ${rustString(manifest.modelRegistry.defaultSlmRepo)};
pub const PRO_SLM_REPO: &str = ${rustString(manifest.modelRegistry.proSlmRepo)};

/// Full resolved manifest, embedded so runtime brand overrides can be validated
/// against the exact build-time contract.
pub const BRAND_MANIFEST_JSON: &str = include_str!("../resources/brand.config.json");
`;
}

interface GeneratedFile {
  relativePath: string;
  content: string;
}

export function generateTextFiles(manifest: BrandManifest, root = REPO_ROOT, version = "0.1.0"): GeneratedFile[] {
  return [
    { relativePath: "frontend/src-tauri/tauri.conf.json", content: renderTauriConfig(manifest, version) },
    { relativePath: "frontend/src-tauri/capabilities/default.json", content: renderCapabilities(manifest) },
    { relativePath: "frontend/src-tauri/resources/brand.config.json", content: json(manifest) },
    { relativePath: "frontend/src-tauri/src/generated_brand.rs", content: renderGeneratedBrandRs(manifest) },
    { relativePath: "frontend/src/generated/brand.ts", content: renderBrandTs(manifest) },
    { relativePath: "frontend/src/styles/brand-tokens.css", content: renderBrandTokensCss(manifest) },
    { relativePath: "brand/generated/brand.resolved.json", content: json(manifest) },
  ];
}

function writeIfChanged(absolutePath: string, content: string, checkOnly: boolean): boolean {
  const exists = fs.existsSync(absolutePath);
  const previous = exists ? fs.readFileSync(absolutePath, "utf8") : null;
  if (previous === content) return false;
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
  return true;
}

async function renderPng(svgPath: string, size: number, outputPath: string): Promise<void> {
  const { default: sharp } = await import("sharp");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(svgPath, { density: 384 }).resize(size, size, { fit: "contain" }).png().toFile(outputPath);
}

async function generateIcons(manifest: BrandManifest, root: string, checkOnly: boolean): Promise<string[]> {
  const iconsDir = path.join(root, "frontend/src-tauri/icons");
  const svgPath = path.resolve(root, manifest.assets.appIconSvg);
  const stale: string[] = [];
  const required = [
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
    "icon.icns",
    "icon.ico",
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(iconsDir, file))) stale.push(`frontend/src-tauri/icons/${file}`);
  }
  if (checkOnly || stale.length === 0) return stale;

  const tauriBin = path.join(root, "frontend/node_modules/.bin/tauri");
  let iconPipelineOk = false;
  if (fs.existsSync(tauriBin)) {
    const result = spawnSync(tauriBin, ["icon", svgPath, "-o", iconsDir], {
      cwd: path.join(root, "frontend"),
      encoding: "utf8",
      env: { ...process.env },
    });
    iconPipelineOk = result.status === 0;
    if (!iconPipelineOk) {
      console.warn(`warning: tauri icon failed, falling back to sharp (${result.stderr || result.stdout})`);
    }
  }

  try {
    await renderPng(svgPath, 32, path.join(iconsDir, "32x32.png"));
    await renderPng(svgPath, 128, path.join(iconsDir, "128x128.png"));
    await renderPng(svgPath, 256, path.join(iconsDir, "128x128@2x.png"));
    await renderPng(svgPath, 512, path.join(iconsDir, "icon.png"));

    const traySvg = path.resolve(root, manifest.assets.trayIconMonochrome.replace(/\.png$/i, ".svg"));
    if (fs.existsSync(traySvg)) {
      const trayPng = path.resolve(root, manifest.assets.trayIconMonochrome);
      await renderPng(traySvg, 32, trayPng);
      await renderPng(traySvg, 32, path.join(iconsDir, "tray-Template.png"));
      await renderPng(traySvg, 64, path.join(iconsDir, "tray-Template@2x.png"));
      const resourcesDir = path.join(root, "frontend/src-tauri/resources");
      fs.mkdirSync(resourcesDir, { recursive: true });
      fs.copyFileSync(trayPng, path.join(resourcesDir, "tray-Template.png"));
    }

    if (process.platform === "darwin") {
      const iconset = `${fs.mkdtempSync(path.join(os.tmpdir(), "use-memo-iconset-"))}.iconset`;
      const entries: Array<[string, number]> = [
        ["icon_16x16.png", 16],
        ["icon_16x16@2x.png", 32],
        ["icon_32x32.png", 32],
        ["icon_32x32@2x.png", 64],
        ["icon_128x128.png", 128],
        ["icon_128x128@2x.png", 256],
        ["icon_256x256.png", 256],
        ["icon_256x256@2x.png", 512],
        ["icon_512x512.png", 512],
        ["icon_512x512@2x.png", 1024],
      ];
      for (const [name, size] of entries) await renderPng(svgPath, size, path.join(iconset, name));
      const icns = spawnSync("iconutil", ["-c", "icns", iconset, "-o", path.join(iconsDir, "icon.icns")], {
        encoding: "utf8",
      });
      if (icns.status !== 0) console.warn(`warning: iconutil failed (${icns.stderr})`);
      fs.rmSync(iconset, { recursive: true, force: true });
    }

    if (!iconPipelineOk && process.platform !== "win32") {
      console.warn("warning: icon.ico was not generated; run `pnpm brand:apply` after `pnpm install` on a build host");
    }
  } catch (error) {
    console.warn(`warning: icon generation incomplete: ${(error as Error).message}`);
  }
  return stale;
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export interface ApplyOptions {
  profile?: string;
  check?: boolean;
  root?: string;
  skipIcons?: boolean;
}

export interface ApplyResult {
  manifest: BrandManifest;
  staleFiles: string[];
  writtenFiles: string[];
}

export async function applyBrand(options: ApplyOptions = {}): Promise<ApplyResult> {
  const root = options.root ?? REPO_ROOT;
  const checkOnly = options.check ?? false;
  const manifest = loadManifest({ profile: options.profile, root });
  const errors = validateManifest(manifest, root);
  if (errors.length > 0) {
    throw new Error(`Invalid brand manifest:\n - ${errors.join("\n - ")}`);
  }

  const version = readVersion(root);
  const staleFiles: string[] = [];
  const writtenFiles: string[] = [];
  for (const file of generateTextFiles(manifest, root, version)) {
    const changed = writeIfChanged(path.join(root, file.relativePath), file.content, checkOnly);
    if (changed) {
      staleFiles.push(file.relativePath);
      if (!checkOnly) writtenFiles.push(file.relativePath);
    }
  }

  if (!options.skipIcons) {
    const iconStale = await generateIcons(manifest, root, checkOnly);
    staleFiles.push(...iconStale);
    if (!checkOnly) writtenFiles.push(...iconStale);
  }

  return { manifest, staleFiles, writtenFiles };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profile = args.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length);
  const check = args.includes("--check");
  const skipIcons = args.includes("--no-icons");

  try {
    const result = await applyBrand({ profile, check, skipIcons });
    if (check) {
      if (result.staleFiles.length > 0) {
        console.error("Brand outputs are stale. Run `pnpm brand:apply`:");
        for (const file of result.staleFiles) console.error(`  - ${file}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Brand outputs are current for ${result.manifest.productName}.`);
      return;
    }
    console.log(`Applied brand ${result.manifest.productName} (${result.manifest.brandId}).`);
    if (result.writtenFiles.length === 0) {
      console.log("All generated files were already current.");
    } else {
      for (const file of result.writtenFiles) console.log(`  wrote ${file}`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
