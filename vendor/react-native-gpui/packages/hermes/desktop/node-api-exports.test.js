// The Node-API export list ships with the engine package and is what the app's
// executable forwards to `hermesvm.dll`, so a name that appears in one and not
// the other is a load-time failure for that addon. This regenerates the list
// from the installed hermesvm and fails on any difference.
//
// Only the Windows branch can be run on this machine; the `nm` branches are
// written from their documented flags and are listed as untested in
// `.local/WINDOWS_GAPS_REPORT.md`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const listPath = path.join(packageRoot, 'desktop', 'node-api-exports.txt');

/** The library name per platform, as `fetch-binaries.mjs` stages it. */
function libraryPath() {
  const binRoot =
    process.env.RN_GPUI_HERMES_BIN_ROOT ?? path.join(packageRoot, 'bin');
  if (process.platform === 'win32') {
    return path.join(
      binRoot,
      `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      'hermesvm.dll',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(binRoot, `darwin-${process.arch}`, 'libhermesvm.dylib');
  }
  return path.join(binRoot, `linux-${process.arch}`, 'libhermesvm.so');
}

/**
 * Runs `command` and returns stdout, or null when the tool is not installed.
 * Skipping is deliberate: the test is about the list matching the library, and
 * a missing tool is an environment fact, not a defect in the list.
 */
function tryRun(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Every Node-API name the library exports, sorted, without duplicates. */
function exportedNames(library) {
  const names = new Set();
  if (process.platform === 'win32') {
    const output = tryRun('dumpbin', ['/exports', library]);
    if (output === null) return null;
    for (const line of output.split('\n')) {
      // Rows look like `          1    0 00001234 napi_create_function`.
      const match = line.match(/\s((?:napi_|node_api_)\w+)\s*$/u);
      if (match) names.add(match[1]);
    }
  } else if (process.platform === 'darwin') {
    const output = tryRun('nm', ['-gU', library]);
    if (output === null) return null;
    // Mach-O prefixes C symbols with an underscore.
    for (const line of output.split('\n')) {
      const match = line.match(/\s_?((?:napi_|node_api_)\w+)\s*$/u);
      if (match) names.add(match[1]);
    }
  } else {
    const output = tryRun('nm', ['-D', '--defined-only', library]);
    if (output === null) return null;
    for (const line of output.split('\n')) {
      const match = line.match(/\s((?:napi_|node_api_)\w+)\s*$/u);
      if (match) names.add(match[1]);
    }
  }
  return [...names].sort();
}

const library = libraryPath();
const available = fs.existsSync(library);
const regenerated = available ? exportedNames(library) : null;
const toolMissing = available && regenerated === null;

describe.skipIf(!available || toolMissing)('node-api export list', () => {
  test('matches the names the installed engine exports', () => {
    const declared = fs
      .readFileSync(listPath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    expect(declared).toEqual([...declared].sort());
    expect(new Set(declared).size).toBe(declared.length);
    // Compare as sets so a failure names the names, not the ordering.
    const missing = declared.filter(name => !regenerated.includes(name));
    const extra = regenerated.filter(name => !declared.includes(name));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});
