import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { collectInputs, inputHash, runtimeChoice } from './prebuilt-inputs.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);

function packageFiles() {
  return JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    .files;
}

// `react-native/package.json` is the React Native pin: it lives in the
// consumer's install, not in this package, so it is deliberately not in
// `files`.
const EXTERNAL_PREFIX = 'react-native/';

/// Does an `npm pack` of this package include `relPath`? npm treats a `files`
/// entry as covering the file itself and everything under it.
export function coveredByFiles(relPath, files) {
  return files.some(
    entry => relPath === entry || relPath.startsWith(`${entry}/`),
  );
}

describe('collectInputs', () => {
  test('uses the pinned prebuilt while the inputs match the pin', () => {
    const pin = JSON.parse(
      readFileSync(path.join(packageDir, 'prebuilt-binaries.json'), 'utf8'),
    );
    const choice = runtimeChoice({ ...pin, inputHash: inputHash().hash });
    expect(choice.kind).toBe('prebuilt');
    expect(choice.version).toBe(pin.version);
  });

  test('falls back to source, with a reason, when the inputs changed', () => {
    const pin = JSON.parse(
      readFileSync(path.join(packageDir, 'prebuilt-binaries.json'), 'utf8'),
    );
    const choice = runtimeChoice({ ...pin, inputHash: 'not-the-local-hash' });
    expect(choice.kind).toBe('source');
    expect(choice.reason).toContain(inputHash().hash);
    expect(choice.reason).toContain('not-the-local-hash');
  });

  test('keys every path without the checkout location', () => {
    for (const { path: rel } of collectInputs()) {
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel).not.toContain('..');
      // Always POSIX separators, so a Windows checkout hashes identically.
      expect(rel).not.toContain('\\');
    }
  });

  test('hashes the files and folders the archive is built from', () => {
    const paths = collectInputs().map(entry => entry.path);
    for (const expected of [
      'ReactGpui/Cargo.lock',
      'ReactGpui/rn-gpui-sys/src/lib.rs',
      'ReactGpui/rn-gpui-sys/cpp/GpuiHost.cpp',
      'scripts/build-prebuilt.mjs',
      'scripts/prebuilt-inputs.mjs',
      'react-native/package.json',
    ]) {
      expect(paths).toContain(expected);
    }
  });
});

describe('core package.json files', () => {
  // If a hashed path is not published, an installed package hashes fewer files
  // than the pin was built from and can never match, so every consumer falls
  // back to building React Native from source.
  test('covers every path collectInputs() returns', () => {
    const files = packageFiles();
    const uncovered = collectInputs()
      .map(entry => entry.path)
      .filter(rel => !rel.startsWith(EXTERNAL_PREFIX))
      .filter(rel => !coveredByFiles(rel, files));
    expect(uncovered).toEqual([]);
  });

  test('covers every inputHash entry, including on a packed install', () => {
    const files = packageFiles();
    const uncovered = inputHash()
      .files.map(entry => entry.path)
      .filter(rel => !rel.startsWith(EXTERNAL_PREFIX))
      .filter(rel => !coveredByFiles(rel, files));
    expect(uncovered).toEqual([]);
  });

  test('coveredByFiles treats a folder entry as covering its contents', () => {
    expect(coveredByFiles('a/b/c.cpp', ['a/b'])).toBe(true);
    expect(coveredByFiles('a/b', ['a/b'])).toBe(true);
    expect(coveredByFiles('a/bc', ['a/b'])).toBe(false);
    expect(coveredByFiles('a/b/c.cpp', ['a'])).toBe(true);
  });

  test('the published package.json is the one the test read', () => {
    // Guards against the test passing because it read a different manifest.
    expect(require(path.join(packageDir, 'package.json')).name).toBe(
      '@react-native-gpui/core',
    );
  });
});
