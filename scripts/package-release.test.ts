import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectArtifacts,
  defaultReleaseDir,
  findBundleRoot,
  hashFile,
  normalizeArch,
  packageRelease,
  readGitState,
  releaseFileName,
  releaseTimestamp,
  renderChecksumFile,
  renderReleaseManifest,
  stageArtifacts,
  type ReleaseArtifact,
} from "./package-release.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "use-memo-release-"));
}

test("release names are normalized per platform and version", () => {
  assert.equal(
    releaseFileName({
      slug: "use-memo",
      version: "0.1.0",
      platform: "macos",
      arch: "arm64",
      suffix: ".dmg",
    }),
    "use-memo_0.1.0_macos_arm64.dmg",
  );
  assert.equal(
    releaseFileName({
      slug: "use-memo",
      version: "0.2.0-beta.1+sha",
      platform: "windows",
      arch: "x86_64",
      suffix: ".msi",
    }),
    "use-memo_0.2.0-beta.1_sha_windows_x86_64.msi",
  );
  assert.equal(normalizeArch("x64"), "x86_64");
  assert.equal(normalizeArch("arm64"), "arm64");
});

test("artifact discovery understands every Tauri bundle directory", () => {
  const root = tempDir();
  try {
    const write = (relativePath: string) => {
      const absolute = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, relativePath);
    };
    write("dmg/UseMemo_0.1.0_aarch64.dmg");
    write("macos/UseMemo.app/Contents/Info.plist");
    write("nsis/UseMemo_0.1.0_x64-setup.exe");
    write("msi/UseMemo_0.1.0_x64_en-US.msi");
    write("deb/use-memo_0.1.0_amd64.deb");
    write("appimage/use-memo_0.1.0_amd64.AppImage");
    write("rpm/use-memo-0.1.0-1.x86_64.rpm");

    const mac = collectArtifacts(root, "macos");
    assert.deepEqual(
      mac.map((artifact) => [path.basename(artifact.sourcePath), artifact.kind]),
      [["UseMemo_0.1.0_aarch64.dmg", "dmg"]],
    );
    const windows = collectArtifacts(root, "windows");
    assert.deepEqual(
      windows.map((artifact) => [path.basename(artifact.sourcePath), artifact.kind]),
      [
        ["UseMemo_0.1.0_x64-setup.exe", "nsis"],
        ["UseMemo_0.1.0_x64_en-US.msi", "msi"],
      ],
    );
    const linux = collectArtifacts(root, "linux");
    assert.deepEqual(
      linux.map((artifact) => [path.basename(artifact.sourcePath), artifact.kind]),
      [
        ["use-memo_0.1.0_amd64.deb", "deb"],
        ["use-memo_0.1.0_amd64.AppImage", "appimage"],
        ["use-memo-0.1.0-1.x86_64.rpm", "rpm"],
      ],
    );
    assert.deepEqual(collectArtifacts(path.join(root, "missing"), "macos"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging copies installers, hashes them, and rejects a platform with no installers", () => {
  const root = tempDir();
  try {
    const source = path.join(root, "bundle", "dmg", "UseMemo_0.1.0_aarch64.dmg");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "fake dmg bytes");
    const outDir = path.join(root, "release");

    const artifacts = stageArtifacts({
      bundleRoot: path.join(root, "bundle"),
      outDir,
      slug: "use-memo",
      version: "0.1.0",
      platform: "macos",
      arch: "arm64",
    });

    assert.equal(artifacts.length, 1);
    const artifact = artifacts[0];
    assert.equal(artifact.name, "use-memo_0.1.0_macos_arm64.dmg");
    assert.equal(artifact.kind, "dmg");
    assert.equal(artifact.bytes, Buffer.byteLength("fake dmg bytes"));
    assert.equal(artifact.sha256, hashFile(source));
    assert.equal(fs.readFileSync(path.join(outDir, artifact.name), "utf8"), "fake dmg bytes");

    assert.throws(
      () =>
        stageArtifacts({
          bundleRoot: path.join(root, "bundle"),
          outDir: path.join(root, "windows"),
          slug: "use-memo",
          version: "0.1.0",
          platform: "windows",
          arch: "x86_64",
        }),
      /No installers found for windows/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checksum and manifest output is sorted and stable", () => {
  const artifacts: ReleaseArtifact[] = [
    { name: "b.dmg", kind: "dmg", bytes: 2, sha256: "b".repeat(64) },
    { name: "a.dmg", kind: "dmg", bytes: 1, sha256: "a".repeat(64) },
  ];

  assert.equal(
    renderChecksumFile(artifacts),
    `${"a".repeat(64)}  a.dmg\n${"b".repeat(64)}  b.dmg\n`,
  );

  const manifest = {
    schemaVersion: 1 as const,
    brandId: "use-memo",
    productName: "UseMemo",
    version: "0.1.0",
    bundleIdentifier: "org.gnu.usememo",
    license: "GPL-3.0-or-later",
    platform: "macos" as const,
    arch: "arm64",
    commit: "abc123",
    dirty: false,
    builtAt: "2026-01-01T00:00:00.000Z",
    signature: null,
    artifacts,
  };
  const rendered = renderReleaseManifest(manifest);
  assert.equal(rendered, renderReleaseManifest(manifest));
  const parsed = JSON.parse(rendered) as { artifacts: Array<{ name: string }> };
  assert.deepEqual(
    parsed.artifacts.map((artifact) => artifact.name),
    ["a.dmg", "b.dmg"],
  );
  assert.ok(rendered.endsWith("\n"));
});

test("bundle lookup accepts both workspace and crate-local target directories", () => {
  const root = tempDir();
  try {
    assert.throws(() => findBundleRoot(root, ""), /No Tauri bundle found/);

    fs.mkdirSync(path.join(root, "target", "release", "bundle"), { recursive: true });
    assert.equal(findBundleRoot(root, ""), path.join(root, "target", "release", "bundle"));

    const other = tempDir();
    try {
      fs.mkdirSync(path.join(other, "frontend", "src-tauri", "target", "release", "bundle"), {
        recursive: true,
      });
      assert.equal(
        findBundleRoot(other, ""),
        path.join(other, "frontend", "src-tauri", "target", "release", "bundle"),
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release directory and timestamps are deterministic inputs", () => {
  const dir = defaultReleaseDir("0.1.0", "macos", "arm64", "/repo");
  assert.equal(dir, path.join("/repo", "dist", "release", "0.1.0", "macos-arm64"));
  assert.equal(
    releaseTimestamp({ SOURCE_DATE_EPOCH: "1700000000" }),
    "2023-11-14T22:13:20.000Z",
  );
  assert.throws(() => releaseTimestamp({ SOURCE_DATE_EPOCH: "soon" }), /SOURCE_DATE_EPOCH/);
});

test("git state is read from the repository that owns the sources", () => {
  const state = readGitState();
  assert.ok(state.commit === null || /^[0-9a-f]{40}$/.test(state.commit));
  assert.equal(typeof state.dirty, "boolean");
});

test("packaging without a bundle fails with an actionable message", () => {
  const root = tempDir();
  try {
    assert.throws(
      () => packageRelease({ skipBuild: true, root }),
      /ENOENT|No Tauri bundle found|no such file/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
