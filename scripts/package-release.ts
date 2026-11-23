/**
 * M8.14 — offline release packaging.
 *
 * Turns the Tauri bundle output into a self-describing release directory:
 * normalized installer names, SHA-256 checksums, and a manifest that records
 * the brand, version, platform, git commit, and artifact hashes. Nothing is
 * uploaded: the directory is meant to be copied to removable media or an
 * internal file share, which keeps the product's offline promise intact.
 *
 * Usage:
 *   pnpm package:release                 # build, then package
 *   pnpm package:release --skip-build    # package an existing bundle
 *   pnpm package:release --require-signature
 *   pnpm package:release --require-notarization
 *   pnpm package:release --profile=clinical-scribe-offline
 *
 * Environment:
 *   CARGO_TARGET_DIR      override the Cargo target directory
 *   SOURCE_DATE_EPOCH      freeze the manifest timestamp for reproducible runs
 *   APPLE_SIGNING_IDENTITY  Developer ID Application identity (read by Tauri)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, loadManifest } from "./apply-brand.ts";

export type ReleasePlatform = "macos" | "windows" | "linux";
export type ArtifactKind = "dmg" | "nsis" | "msi" | "deb" | "appimage" | "rpm";

export interface ReleaseArtifact {
  name: string;
  kind: ArtifactKind;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  brandId: string;
  productName: string;
  version: string;
  bundleIdentifier: string;
  license: string;
  platform: ReleasePlatform;
  arch: string;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
  signature: ReleaseSignature | null;
  artifacts: ReleaseArtifact[];
}

export interface ReleaseSignature {
  verified: boolean;
  adHoc: boolean;
  authority: string | null;
  audioInputEntitlement: boolean;
  notarized: boolean;
}

export interface SignatureReport {
  verified: boolean;
  adHoc: boolean;
  authority: string | null;
  audioInputEntitlement: boolean;
  notarized: boolean;
  warnings: string[];
}

const ARTIFACT_LAYOUT: Record<
  ReleasePlatform,
  Array<{ directory: string; suffix: string; kind: ArtifactKind }>
> = {
  macos: [{ directory: "dmg", suffix: ".dmg", kind: "dmg" }],
  windows: [
    { directory: "nsis", suffix: ".exe", kind: "nsis" },
    { directory: "msi", suffix: ".msi", kind: "msi" },
  ],
  linux: [
    { directory: "deb", suffix: ".deb", kind: "deb" },
    { directory: "appimage", suffix: ".AppImage", kind: "appimage" },
    { directory: "rpm", suffix: ".rpm", kind: "rpm" },
  ],
};

export function currentPlatform(): ReleasePlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported release platform: ${process.platform}`);
}

export function normalizeArch(arch = process.arch): string {
  if (arch === "x64") return "x86_64";
  if (arch === "ia32") return "i686";
  return arch;
}

function safeFileToken(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, "_");
}

export function releaseFileName(input: {
  slug: string;
  version: string;
  platform: ReleasePlatform;
  arch: string;
  suffix: string;
}): string {
  return `${safeFileToken(input.slug)}_${safeFileToken(input.version)}_${input.platform}_${input.arch}${input.suffix}`;
}

/**
 * Cargo puts the bundle either at the workspace target directory or next to
 * the Tauri crate, depending on how the build was invoked. Accept both.
 */
export function findBundleRoot(root = REPO_ROOT, targetDir = process.env.CARGO_TARGET_DIR): string {
  const bases = [
    targetDir ? path.resolve(root, targetDir) : null,
    path.join(root, "target"),
    path.join(root, "frontend/src-tauri/target"),
  ].filter((candidate): candidate is string => candidate !== null);

  const bundleRoots = bases.map((base) => path.join(base, "release", "bundle"));
  const existing = bundleRoots.find((candidate) => fs.existsSync(candidate));
  if (!existing) {
    throw new Error(
      `No Tauri bundle found. Looked in:\n${bundleRoots.map((candidate) => `  - ${candidate}`).join("\n")}\n` +
        "Run `pnpm tauri:build` first, or drop --skip-build.",
    );
  }
  return existing;
}

export function collectArtifacts(bundleRoot: string, platform = currentPlatform()): Array<{
  sourcePath: string;
  kind: ArtifactKind;
}> {
  const artifacts: Array<{ sourcePath: string; kind: ArtifactKind }> = [];
  for (const entry of ARTIFACT_LAYOUT[platform]) {
    const directory = path.join(bundleRoot, entry.directory);
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(entry.suffix)).sort()) {
      artifacts.push({ sourcePath: path.join(directory, name), kind: entry.kind });
    }
  }
  return artifacts;
}

export function hashFile(file: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

export function renderChecksumFile(artifacts: ReleaseArtifact[]): string {
  return `${[...artifacts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n")}\n`;
}

export function renderReleaseManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(
    {
      ...manifest,
      artifacts: [...manifest.artifacts].sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  )}\n`;
}

function gitValue(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function readGitState(root = REPO_ROOT): { commit: string | null; dirty: boolean } {
  const commit = gitValue(root, ["rev-parse", "HEAD"]);
  const status = gitValue(root, ["status", "--porcelain"]);
  return { commit, dirty: status === null ? true : status.length > 0 };
}

export function releaseTimestamp(env = process.env): string {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== "") {
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds)) throw new Error(`SOURCE_DATE_EPOCH is not a number: ${epoch}`);
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

export function defaultReleaseDir(
  version: string,
  platform = currentPlatform(),
  arch = normalizeArch(),
  root = REPO_ROOT,
): string {
  return path.join(root, "dist", "release", safeFileToken(version), `${platform}-${arch}`);
}

export function stageArtifacts(input: {
  bundleRoot: string;
  outDir: string;
  slug: string;
  version: string;
  platform?: ReleasePlatform;
  arch?: string;
}): ReleaseArtifact[] {
  const platform = input.platform ?? currentPlatform();
  const arch = input.arch ?? normalizeArch();
  const collected = collectArtifacts(input.bundleRoot, platform);
  if (collected.length === 0) {
    throw new Error(
      `No installers found for ${platform} under ${input.bundleRoot}.\n` +
        "Check bundle.targets in tauri.conf.json (macOS needs dmg, Windows nsis/msi, Linux deb/appimage/rpm).",
    );
  }

  fs.mkdirSync(input.outDir, { recursive: true });
  const staged: ReleaseArtifact[] = [];
  for (const artifact of collected) {
    const name = releaseFileName({
      slug: input.slug,
      version: input.version,
      platform,
      arch,
      suffix: path.extname(artifact.sourcePath),
    });
    if (staged.some((candidate) => candidate.name === name)) {
      throw new Error(`Two installers map to the same release name: ${name}`);
    }
    const destination = path.join(input.outDir, name);
    fs.copyFileSync(artifact.sourcePath, destination);
    staged.push({
      name,
      kind: artifact.kind,
      bytes: fs.statSync(destination).size,
      sha256: hashFile(destination),
    });
  }
  return staged.sort((a, b) => a.name.localeCompare(b.name));
}

function run(command: string, args: string[], options: { encoding?: BufferEncoding } = {}): string {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return `${stdout}${stderr}`;
}

/**
 * macOS Gatekeeper checks. A locally built app is ad-hoc signed by Tauri: it
 * runs on the build machine but is not notarized, so `spctl` will reject it.
 * Report that honestly instead of failing the packaging step.
 */
export function verifyMacApp(appPath: string): SignatureReport {
  const warnings: string[] = [];
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], { encoding: "utf8" });
  const verified = verify.status === 0;
  if (!verified) warnings.push("codesign verification failed; the app may be modified or unsigned");

  const details = run("codesign", ["-dv", "--verbose=4", appPath]);
  const authority = /^Authority=(.+)$/m.exec(details)?.[1]?.trim() ?? null;
  const adHoc = /^Signature=adhoc$/m.test(details);
  if (adHoc) warnings.push("ad-hoc signature: fine for local testing, not for distribution");
  if (!authority && !adHoc) warnings.push("no signing authority recorded");

  const entitlementsDump = run("codesign", ["-d", "--entitlements", ":-", appPath]);
  const audioInputEntitlement = /com\.apple\.security\.device\.audio-input/.test(entitlementsDump);
  if (!audioInputEntitlement) {
    warnings.push("audio-input entitlement missing: microphone capture may return silence");
  }

  const assess = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const notarized = assess.status === 0;
  if (!notarized) {
    warnings.push("Gatekeeper rejects the app until it is Developer ID signed and notarized");
  }

  return { verified, adHoc, authority, audioInputEntitlement, notarized, warnings };
}

export interface PackageOptions {
  skipBuild?: boolean;
  requireSignature?: boolean;
  requireNotarization?: boolean;
  profile?: string;
  outDir?: string;
  root?: string;
  platform?: ReleasePlatform;
  arch?: string;
}

export interface PackageResult {
  manifest: ReleaseManifest;
  outDir: string;
  checksumPath: string;
  manifestPath: string;
  signature: SignatureReport | null;
  warnings: string[];
}

function readVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

function rustHostTriple(cwd: string): string {
  const out = spawnSync("rustc", ["-vV"], { cwd, encoding: "utf8" });
  const match = /^host:\s+(\S+)$/m.exec(out.stdout ?? "");
  if (match?.[1]) return match[1];
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

export function stageLlamaWorkerSidecar(root = REPO_ROOT): string {
  const triple = rustHostTriple(root);
  const ext = process.platform === "win32" ? ".exe" : "";
  console.log(`> cargo build --release -p memo-llama-worker (${triple})`);
  const workerBuild = spawnSync("cargo", ["build", "--release", "-p", "memo-llama-worker"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (workerBuild.status !== 0) {
    throw new Error(`memo-llama-worker build failed with exit code ${workerBuild.status ?? "unknown"}`);
  }

  const targetRoot = process.env.CARGO_TARGET_DIR
    ? path.resolve(root, process.env.CARGO_TARGET_DIR)
    : path.join(root, "target");
  const builtWorker = path.join(targetRoot, "release", `memo-litert-worker${ext}`);
  if (!fs.existsSync(builtWorker)) {
    throw new Error(`Expected built worker binary at ${builtWorker}`);
  }

  const binariesDir = path.join(root, "frontend", "src-tauri", "binaries");
  fs.mkdirSync(binariesDir, { recursive: true });
  const sidecarDest = path.join(binariesDir, `memo-litert-worker-${triple}${ext}`);
  fs.copyFileSync(builtWorker, sidecarDest);
  if (process.platform !== "win32") {
    fs.chmodSync(sidecarDest, 0o755);
  }
  return sidecarDest;
}

/**
 * CI expands unset secrets to empty strings. Tauri treats an empty
 * APPLE_SIGNING_IDENTITY as a real identity (overriding the ad-hoc "-" in
 * tauri.conf.json) and codesign then fails, so empty APPLE_* values are dropped.
 */
export function tauriBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(cleaned)) {
    if (key.startsWith("APPLE_") && value === "") delete cleaned[key];
  }
  return cleaned;
}

export function packageRelease(options: PackageOptions = {}): PackageResult {
  const root = options.root ?? REPO_ROOT;
  const platform = options.platform ?? currentPlatform();
  const arch = options.arch ?? normalizeArch();
  const manifest = loadManifest({ profile: options.profile, root });
  const version = readVersion(root);
  const warnings: string[] = [];

  if (!options.skipBuild) {
    const brandArgs = ["brand:apply"];
    if (options.profile) {
      brandArgs.push(`--profile=${options.profile}`);
    }
    console.log(`> pnpm ${brandArgs.join(" ")} (${manifest.productName})`);
    const apply = spawnSync("pnpm", brandArgs, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (apply.status !== 0) {
      throw new Error(`Brand codegen failed with exit code ${apply.status ?? "unknown"}`);
    }

    stageLlamaWorkerSidecar(root);

    // The overlay goes through a file: on Windows the build runs via cmd.exe,
    // which strips the quotes out of an inline JSON argument.
    const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), "use-memo-tauri-"));
    const overlayPath = path.join(overlayDir, "sidecar.conf.json");
    fs.writeFileSync(
      overlayPath,
      JSON.stringify({ bundle: { externalBin: ["binaries/memo-litert-worker"] } }),
    );
    const overlayArg = process.platform === "win32" ? `"${overlayPath}"` : overlayPath;
    console.log(`> tauri build (${manifest.productName} ${version})`);
    let build: ReturnType<typeof spawnSync>;
    try {
      build = spawnSync(
        "pnpm",
        ["--filter", "@use-memo/frontend", "exec", "tauri", "build", "--config", overlayArg],
        {
          cwd: root,
          stdio: "inherit",
          shell: process.platform === "win32",
          env: tauriBuildEnv(process.env),
        },
      );
    } finally {
      fs.rmSync(overlayDir, { recursive: true, force: true });
    }
    if (build.status !== 0) {
      throw new Error(`Tauri build failed with exit code ${build.status ?? "unknown"}`);
    }
  }

  const bundleRoot = findBundleRoot(root);
  const outDir = options.outDir
    ? path.resolve(root, options.outDir)
    : defaultReleaseDir(version, platform, arch, root);
  const artifacts = stageArtifacts({
    bundleRoot,
    outDir,
    slug: manifest.brandId,
    version,
    platform,
    arch,
  });

  const git = readGitState(root);

  let signature: SignatureReport | null = null;
  if (platform === "macos") {
    const appBundle = path.join(bundleRoot, "macos", `${manifest.productName}.app`);
    if (fs.existsSync(appBundle)) {
      signature = verifyMacApp(appBundle);
      warnings.push(...signature.warnings);
    } else {
      warnings.push(`expected app bundle not found: ${appBundle}`);
    }
  }

  const release: ReleaseManifest = {
    schemaVersion: 1,
    brandId: manifest.brandId,
    productName: manifest.productName,
    version,
    bundleIdentifier: manifest.bundleIdentifier,
    license: manifest.licenseType,
    platform,
    arch,
    commit: git.commit,
    dirty: git.dirty,
    builtAt: releaseTimestamp(),
    signature: signature
      ? {
          verified: signature.verified,
          adHoc: signature.adHoc,
          authority: signature.authority,
          audioInputEntitlement: signature.audioInputEntitlement,
          notarized: signature.notarized,
        }
      : null,
    artifacts,
  };

  const checksumPath = path.join(outDir, "SHA256SUMS.txt");
  const manifestPath = path.join(outDir, "release-manifest.json");
  fs.writeFileSync(checksumPath, renderChecksumFile(artifacts), "utf8");
  fs.writeFileSync(manifestPath, renderReleaseManifest(release), "utf8");

  if (git.dirty) {
    warnings.push("working tree is dirty: the manifest commit does not describe every input");
  }

  if (options.requireSignature) {
    if (platform === "macos") {
      if (!signature?.verified) throw new Error("Signature required, but codesign verification failed");
      if (signature.adHoc) throw new Error("Signature required, but the app is only ad-hoc signed");
      if (!signature.audioInputEntitlement) {
        throw new Error("Signature required, but the audio-input entitlement is missing");
      }
    } else if (platform === "windows") {
      warnings.push("Windows signature verification is not automated; check signtool before publishing");
    }
  }

  if (options.requireNotarization && platform === "macos" && !signature?.notarized) {
    throw new Error(
      "Notarization required, but spctl rejects the app. Developer ID sign it and provide Apple notarization credentials.",
    );
  }

  return { manifest: release, outDir, checksumPath, manifestPath, signature, warnings };
}

function parseOptions(argv: string[]): PackageOptions {
  return {
    skipBuild: argv.includes("--skip-build"),
    requireSignature: argv.includes("--require-signature"),
    requireNotarization: argv.includes("--require-notarization"),
    profile: argv.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length),
    outDir: argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length),
  };
}

async function main(): Promise<void> {
  try {
    const result = packageRelease(parseOptions(process.argv.slice(2)));
    console.log(`\nPackaged ${result.manifest.productName} ${result.manifest.version}`);
    console.log(`  platform  ${result.manifest.platform}-${result.manifest.arch}`);
    console.log(`  commit    ${result.manifest.commit ?? "unknown"}${result.manifest.dirty ? " (dirty)" : ""}`);
    console.log(`  output    ${path.relative(process.cwd(), result.outDir)}`);
    for (const artifact of result.manifest.artifacts) {
      console.log(`  artifact  ${artifact.name} (${artifact.bytes} bytes)`);
      console.log(`            sha256 ${artifact.sha256}`);
    }
    if (result.signature) {
      console.log(
        `  signature ${result.signature.adHoc ? "ad-hoc" : result.signature.authority ?? "unknown"}` +
          `${result.signature.notarized ? ", notarized" : ", not notarized"}`,
      );
    }
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
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
