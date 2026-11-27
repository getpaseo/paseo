#!/usr/bin/env node
// Thin wrapper that invokes vendor-grammars.mjs and vendor-ratex.mjs in
// consumer mode (--from-npm) to download vendored native assets after install.
//
// In the monorepo, grammar-versions.json is not present at the expected path
// (it is only copied during prepack), so this script is a no-op -- the
// `prepare` script handles vendoring via the same scripts with monorepo paths.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG = '[react-native-enriched-markdown]';

// ---------------------------------------------------------------------------
// Consumer opt-out lookup. Kept in this file on purpose: downstream forks pack
// the postinstall by name, so it must not import siblings.
//
// npm/yarn/pnpm set INIT_CWD to the directory the install ran from. For a plain app
// that is the app itself. In a monorepo it is the workspace root, which usually has
// no `enriched-markdown` block of its own, so the lookup continues into the
// workspace members that depend on this package. A root block, when present, wins.
// Workspaces share one node_modules, so an asset is skipped only when every
// consuming app opts out of it.

const PACKAGE_NAME = 'react-native-enriched-markdown';
const MAX_WALK_DEPTH = 6;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function configOf(pkg) {
  const config = pkg?.['enriched-markdown'];
  return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

/** True for any `*ependencies` map (dependencies, devDependencies, peerDependencies, ...). */
function dependsOnPackage(pkg) {
  return Object.entries(pkg ?? {}).some(
    ([field, value]) =>
      /[dD]ependencies$/.test(field) &&
      value && typeof value === 'object' && !Array.isArray(value) &&
      Object.hasOwn(value, PACKAGE_NAME)
  );
}

function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
}

function walk(dir, depth = 0) {
  if (depth >= MAX_WALK_DEPTH) return [dir];
  return [dir, ...subdirs(dir).flatMap((child) => walk(child, depth + 1))];
}

function segmentToRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** Directories matched by one workspace pattern such as `apps/*` or `packages/**`. */
function expand(root, pattern) {
  const segments = pattern.split('/').filter((s) => s && s !== '.');
  let dirs = [root];
  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (segment === '**') {
        next.push(...walk(dir));
      } else if (segment.includes('*')) {
        const re = segmentToRegExp(segment);
        next.push(...subdirs(dir).filter((d) => re.test(path.basename(d))));
      } else {
        next.push(path.join(dir, segment));
      }
    }
    dirs = next;
  }
  return dirs.filter(isDir);
}

/** Strips a trailing `# comment` and surrounding quotes from one YAML scalar. */
function yamlScalar(text) {
  return text.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * The `packages:` list of pnpm-workspace.yaml, read without a YAML parser. Covers
 * the block form (`- apps/*`) and the one-line flow form (`packages: ["apps/*"]`),
 * which is all pnpm's own docs use.
 */
function readPnpmWorkspacePatterns(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    const key = line.match(/^packages\s*:(.*)$/);
    if (key) {
      const flow = yamlScalar(key[1]).match(/^\[(.*)\]$/);
      if (flow) {
        return flow[1].split(',').map(yamlScalar).filter(Boolean);
      }
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\s*(#|$)/.test(line)) continue;
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item) {
      const pattern = yamlScalar(item[1]);
      if (pattern) patterns.push(pattern);
    } else if (/^\S/.test(line)) {
      break;
    }
  }
  return patterns;
}

/** Workspace member directories declared by npm/yarn `workspaces` or pnpm-workspace.yaml. */
function listWorkspaceDirs(root, rootPkg = readJson(path.join(root, 'package.json'))) {
  const declared = rootPkg?.workspaces;
  const patterns = Array.isArray(declared)
    ? declared
    : Array.isArray(declared?.packages)
      ? declared.packages
      : [];
  const dirs = new Set();
  const excluded = new Set();
  for (const pattern of [...patterns, ...readPnpmWorkspacePatterns(root)]) {
    if (typeof pattern !== 'string') continue;
    if (pattern.startsWith('!')) {
      for (const dir of expand(root, pattern.slice(1))) excluded.add(dir);
    } else {
      for (const dir of expand(root, pattern)) dirs.add(dir);
    }
  }
  return [...dirs].filter((dir) => !excluded.has(dir));
}

/**
 * The `enriched-markdown` block that governs this install's downloads: the block of
 * the directory the install ran from, else the flags every consuming workspace
 * member agrees on. `{}` means download everything.
 */
function resolveConsumerConfig(initCwd) {
  if (!initCwd) return {};
  const rootPkg = readJson(path.join(initCwd, 'package.json'));
  const rootConfig = configOf(rootPkg);
  if (rootConfig) return rootConfig;

  const consumers = listWorkspaceDirs(initCwd, rootPkg)
    .map((dir) => readJson(path.join(dir, 'package.json')))
    .filter(dependsOnPackage);
  if (consumers.length === 0) return {};

  // Only `=== false` merges, so non-boolean keys such as `codeHighlightLanguages`
  // drop out on their own and new flags need no edit here.
  const merged = {};
  const keys = new Set(consumers.flatMap((pkg) => Object.keys(configOf(pkg) ?? {})));
  for (const key of keys) {
    if (consumers.every((pkg) => configOf(pkg)?.[key] === false)) merged[key] = false;
  }
  return merged;
}

// `--resolve-config` prints the lookup result and exits, for tests and debugging.
if (process.argv.includes('--resolve-config')) {
  const initCwd = process.env.INIT_CWD;
  console.log(JSON.stringify({
    workspaceDirs: initCwd ? listWorkspaceDirs(initCwd) : [],
    config: resolveConsumerConfig(initCwd),
  }));
  process.exit(0);
}

const grammarManifest = path.join(PKG_ROOT, 'cpp/highlight/grammar-versions.json');
if (!fs.existsSync(grammarManifest)) {
  console.log(`${LOG} grammar-versions.json not found; skipping postinstall.`);
  console.log(`${LOG} This is expected in monorepo development (use \`yarn prepare\`).`);
  process.exit(0);
}

// Consumer opt-out. The consumer declares which heavy native assets to skip
// downloading via an `enriched-markdown` block in package.json:
//
//   { "enriched-markdown": { "enableCodeHighlight": false, "enableMath": false } }
//
// Both features default to enabled (opt-out, not opt-in). The block is read from
// INIT_CWD (where the install ran) and, in a monorepo whose root has no block, from
// the workspace members that depend on this package -- see the lookup above.
// Any resolution failure falls back to downloading everything: a skipped download
// is far cheaper to recover from than a silently missing feature.
//
// The native build reads the *app* package.json directly (via the podspec's
// installation root / gradle's build root -- see the podspecs and android/build.gradle),
// which is a separate per-app decision. It reconciles that flag with asset presence on
// disk: an explicit opt-in with the asset missing fails loud, a default-on with it
// missing degrades to a clean build.
const consumerConfig = resolveConsumerConfig(process.env.INIT_CWD);

// This script only decides what to DOWNLOAD into node_modules. The native build
// (podspec + build.gradle) reads the app package.json directly to decide what to
// compile/link, so nothing is written here for it to consume. The `codeHighlightLanguages`
// subset is a build-time concern (a language subset is selected from the full downloaded
// grammar set), so it is intentionally not read here. ENV vars are a deprecated fallback,
// honored only when package.json has no explicit value.
let enableCodeHighlight = consumerConfig.enableCodeHighlight;
let enableMath = consumerConfig.enableMath;

if (enableCodeHighlight === undefined && process.env.ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT) {
  console.warn(`${LOG} DEPRECATED: ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT env var will be removed in a future version. Configure via "enriched-markdown".enableCodeHighlight in your package.json instead.`);
  enableCodeHighlight = process.env.ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT !== '0';
}
if (enableMath === undefined && process.env.ENRICHED_MARKDOWN_ENABLE_MATH) {
  console.warn(`${LOG} DEPRECATED: ENRICHED_MARKDOWN_ENABLE_MATH env var will be removed in a future version. Configure via "enriched-markdown".enableMath in your package.json instead.`);
  enableMath = process.env.ENRICHED_MARKDOWN_ENABLE_MATH !== '0';
}

enableCodeHighlight = enableCodeHighlight !== false;
enableMath = enableMath !== false;

if (!enableCodeHighlight && !enableMath) {
  console.log(`${LOG} both code highlighting and math are disabled via package.json ("enriched-markdown"); skipping postinstall.`);
  process.exit(0);
}

console.log(`${LOG} restoring vendored native assets ...`);

const vendorGrammars = path.join(PKG_ROOT, 'vendor-grammars.mjs');
const vendorRatex = path.join(PKG_ROOT, 'vendor-ratex.mjs');
const vendorDir = path.join(PKG_ROOT, 'cpp/highlight/vendor');
const ratexManifest = path.join(PKG_ROOT, 'ratex-version.json');
const iosVendor = path.join(PKG_ROOT, 'ios/vendor');

let failed = false;

// Tree-sitter runtime + grammar C sources
if (enableCodeHighlight) {
  const r1 = spawnSync(process.execPath, [
    vendorGrammars,
    '--from-npm',
    '--vendor-dir', vendorDir,
    '--manifest', grammarManifest,
  ], { stdio: 'inherit' });
  if (r1.status !== 0) {
    console.warn(`${LOG} WARNING: vendor-grammars failed. Code highlighting may not work.`);
    failed = true;
  }
} else {
  console.log(`${LOG} code highlighting disabled via package.json ("enriched-markdown".enableCodeHighlight = false); skipping tree-sitter grammars.`);
}

// RaTeX XCFramework + Swift sources + fonts (iOS math)
if (!enableMath) {
  console.log(`${LOG} math disabled via package.json ("enriched-markdown".enableMath = false); skipping RaTeX.`);
} else if (fs.existsSync(ratexManifest) && fs.existsSync(vendorRatex)) {
  const r2 = spawnSync(process.execPath, [
    vendorRatex,
    '--manifest', ratexManifest,
    '--output', iosVendor,
  ], { stdio: 'inherit' });
  if (r2.status !== 0) {
    console.warn(`${LOG} WARNING: vendor-ratex failed. iOS math rendering may not work.`);
    failed = true;
  }
} else {
  // Math is on (explicitly or by default) but the vendor script or its manifest is
  // absent, so nothing was downloaded. Never fall through silently -- the iOS build
  // would otherwise just quietly ship without math. Warn like any other failure.
  console.warn(`${LOG} WARNING: math is enabled but the RaTeX vendor script or manifest is missing ` +
    `(${vendorRatex}, ${ratexManifest}); iOS math rendering will be unavailable.`);
  failed = true;
}

if (failed) {
  console.warn(
    `${LOG} Some downloads failed. Ensure network access to registry.npmjs.org and github.com, ` +
    `then re-run: node node_modules/react-native-enriched-markdown/postinstall.mjs`
  );
}

console.log(`${LOG} postinstall complete.`);
