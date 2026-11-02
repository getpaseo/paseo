#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNodeModule, repoRoot } from './repo-root.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

// Every path here is relative to this package, never to the repository root.
// A folder move must not invalidate the prebuilt runtime, so the hash has to
// describe the C++ inputs and nothing about where they are checked out. The
// same rule applies to react-native, which is hashed under its own name.
const TREE_INPUTS = [
  'ReactGpui/rn-gpui-sys/cpp',
  'ReactCxxPlatform',
  'ReactCommonOverrides',
];
const FILE_INPUTS = [
  'ReactGpui/Cargo.lock',
  'scripts/build-prebuilt.mjs',
  'scripts/prebuilt-inputs.mjs',
  'ReactGpui/rn-gpui-sys/src/lib.rs',
];
const REACT_NATIVE_INPUT = 'react-native/package.json';

const SKIP_DIRS = new Set(['build', 'node_modules', '.git', 'native-deps']);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function reactNativePackageJson() {
  const installed = findNodeModule(packageDir, 'react-native');
  if (installed) return path.join(installed, 'package.json');
  return path.join(
    repoRoot(scriptDir),
    'node_modules',
    'react-native',
    'package.json',
  );
}

/**
 * The C++ inputs keyed by a path that does not depend on the checkout: package
 * relative for this package's files, and `react-native/package.json` for the
 * React Native pin.
 */
export function collectInputs() {
  const files = new Map();
  for (const rel of TREE_INPUTS) {
    const dir = path.join(packageDir, rel);
    if (!existsSync(dir)) continue;
    for (const full of walk(dir, [])) {
      files.set(
        path.relative(packageDir, full).split(path.sep).join('/'),
        full,
      );
    }
  }
  for (const rel of FILE_INPUTS) {
    const full = path.join(packageDir, rel);
    if (existsSync(full)) files.set(rel, full);
  }
  const reactNative = reactNativePackageJson();
  if (existsSync(reactNative)) files.set(REACT_NATIVE_INPUT, reactNative);
  return [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, full]) => ({ path: rel, file: full }));
}

// Hash with CRLF folded to LF so a Windows checkout with core.autocrlf
// produces the same hashes as macOS and Linux.
function contentSha256(file) {
  const text = readFileSync(file).toString('latin1').replace(/\r\n/gu, '\n');
  return createHash('sha256').update(text, 'latin1').digest('hex');
}

export function inputHash() {
  const hash = createHash('sha256');
  const perFile = [];
  for (const { path: rel, file } of collectInputs()) {
    const digest = contentSha256(file);
    perFile.push({ path: rel, sha256: digest });
    hash.update(`${rel}\0${digest}\n`);
  }
  return { hash: hash.digest('hex'), files: perFile };
}

/**
 * Whether a build should link the pinned prebuilt runtime or compile the C++
 * from source.
 *
 * A changed C++ input is not an error: the pinned archive was built from
 * different sources, so linking it would run code the checkout does not
 * contain. The build falls back to source and verifies the change. `build.rs`
 * makes the same decision in Rust; this is the one place that names the rule
 * for tooling and CI.
 *
 * `pin` is the parsed `prebuilt-binaries.json`; omit it to read the file.
 */
export function runtimeChoice(pin) {
  const pinned = pin ?? readPinFile();
  const local = inputHash().hash;
  if (local === pinned.inputHash) {
    return {
      kind: 'prebuilt',
      version: pinned.version,
      localHash: local,
      pinnedHash: pinned.inputHash,
    };
  }
  return {
    kind: 'source',
    version: pinned.version,
    localHash: local,
    pinnedHash: pinned.inputHash,
    reason: `local C++ inputs hash to ${local}, the pinned prebuilt was built from ${pinned.inputHash}`,
  };
}

function readPinFile() {
  return JSON.parse(
    readFileSync(path.join(packageDir, 'prebuilt-binaries.json'), 'utf8'),
  );
}

// Run as a CLI only when this file is the entry point. The guard matters
// because importers (build-prebuilt.mjs, build.rs via node -e) must not print.
const isEntry =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  if (process.argv.includes('--overrides-sha256')) {
    console.log(overridesSha256());
    process.exit(0);
  }
  if (process.argv.includes('--runtime')) {
    console.log(runtimeChoice().kind);
    process.exit(0);
  }
  const { hash, files } = inputHash();
  if (process.argv.includes('--list')) {
    for (const f of files) console.log(`${f.sha256}  ${f.path}`);
    console.log(`${hash}  <inputHash>`);
  } else {
    console.log(hash);
  }
}

// sha256 over the sorted "file\0sha256" lines of ReactCommonOverrides, joined
// by "\n". build-prebuilt.mjs writes this into the manifest; the CMake prebuilt
// branch receives it from build.rs and compares.
export function overridesSha256() {
  const dir = path.join(packageDir, 'ReactCommonOverrides');
  const files = [];
  walk(dir, files);
  const lines = files
    .map(f => path.relative(dir, f).split(path.sep).join('/'))
    .sort()
    .map(rel => {
      const digest = contentSha256(path.join(dir, rel));
      return `${rel}\0${digest}`;
    });
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
