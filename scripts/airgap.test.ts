/**
 * M7.1 — air-gap guard.
 *
 * The product promise is simple: inference is local, there is no telemetry,
 * and the only network operation is an explicit, hash-verified model download.
 * These tests fail the build if a cloud SDK, vendor endpoint, analytics hook,
 * or remote `connect-src` sneaks in.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const SOURCE_ROOTS = [
  "frontend/src",
  "frontend/src-tauri/src",
  "frontend/src-tauri/capabilities",
  "crates",
  "scripts",
  "brand/brand.config.json",
  "frontend/src-tauri/tauri.conf.json",
  "package.json",
  "frontend/package.json",
  "Cargo.toml",
  "frontend/src-tauri/Cargo.toml",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".rs", ".json", ".toml", ".css", ".js", ".mjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "target", ".next", "out", "gen", ".git"]);

const FORBIDDEN_TOKENS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openai.com",
  "anthropic.com",
  "posthog",
  "sentry.io",
  "mixpanel",
  "amplitude.com",
  "segment.io",
  "segment.com",
  "opentelemetry",
  "datadoghq",
  "newrelic",
  "firebase",
  "supabase",
  "aws-sdk",
  "google-analytics",
  "googletagmanager",
  "telemetry",
  "analytics",
  "from \"openai\"",
  "from '@openai",
  "@anthropic-ai",
  "@sentry/",
  "posthog-js",
];

const ALLOWED_URL_HOSTS = new Set([
  "huggingface.co",
  "json.schemastore.org",
  "schema.tauri.app",
  "github.com",
  "example.com",
  "localhost",
  "127.0.0.1",
  "ipc.localhost",
  "asset.localhost",
]);

function collectFiles(target: string): string[] {
  const absolute = path.join(ROOT, target);
  let entry;
  try {
    entry = statSync(absolute);
  } catch {
    return [];
  }
  if (entry.isFile()) return [absolute];
  if (!entry.isDirectory()) return [];

  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    if (SKIPPED_DIRECTORIES.has(child.name)) return [];
    const childPath = path.join(absolute, child.name);
    if (child.isDirectory()) return collectFiles(path.relative(ROOT, childPath));
    return SOURCE_EXTENSIONS.has(path.extname(child.name)) ? [childPath] : [];
  });
}

const FILES = SOURCE_ROOTS.flatMap(collectFiles).filter(
  (file) => path.basename(file) !== "airgap.test.ts",
);

test("source roots were actually scanned", () => {
  assert.ok(FILES.length > 100, `expected a meaningful source scan, found ${FILES.length} files`);
});

test("no cloud SDKs, vendor endpoints, or telemetry hooks", () => {
  const violations: string[] = [];
  for (const file of FILES) {
    const source = readFileSync(file, "utf8").toLowerCase();
    for (const token of FORBIDDEN_TOKENS) {
      if (source.includes(token)) {
        violations.push(`${path.relative(ROOT, file)}: ${token}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the only remote hosts in source are the model registry and schemas", () => {
  const violations: string[] = [];
  const urlPattern = /\b(?:https?|wss?):\/\/([^\s"'`/?#:)]+)/gi;
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(urlPattern)) {
      const host = match[1].toLowerCase();
      if (host.includes("{")) continue;
      if (!ALLOWED_URL_HOSTS.has(host)) {
        violations.push(`${path.relative(ROOT, file)}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("CSP never permits a remote connect-src", () => {
  const config = JSON.parse(
    readFileSync(path.join(ROOT, "frontend/src-tauri/tauri.conf.json"), "utf8"),
  ) as { app: { security: { csp: string } } };
  const csp = config.app.security.csp;
  const connect = csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src"));
  assert.ok(connect, "connect-src must be explicit");
  const sources = connect.split(/\s+/).slice(1);
  for (const source of sources) {
    assert.notEqual(source, "*", "wildcard connect-src would defeat the air gap");
    assert.ok(
      source === "'self'" ||
        source.startsWith("ipc:") ||
        source.startsWith("http://ipc.localhost") ||
        source.startsWith("http://localhost:") ||
        source.startsWith("ws://localhost:"),
      `unexpected connect-src origin: ${source}`,
    );
  }
});

test("UI code uses no browser network primitives", () => {
  const violations: string[] = [];
  const patterns = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnew\s+WebSocket\s*\(/,
    /navigator\.sendBeacon/,
  ];
  for (const file of FILES.filter((candidate) => candidate.startsWith(path.join(ROOT, "frontend/src")))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        violations.push(`${path.relative(ROOT, file)}: ${pattern.source}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
