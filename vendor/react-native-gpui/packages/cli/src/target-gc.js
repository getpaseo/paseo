/**
 * Keeps a Cargo target directory from growing without bound.
 *
 * Cargo never deletes anything from a target directory on its own. Every change
 * that alters a unit's hash — a feature toggled, a dependency bumped, a new
 * toolchain, an environment variable a build script tracks — leaves the old
 * unit beside the new one, and incremental caches stay behind for crates that
 * are no longer rebuilt. Over weeks of development that is tens of gigabytes.
 *
 * So the CLI records which units each build used — Cargo reports every one,
 * fresh or rebuilt, as JSON — and before a build removes units no recorded build
 * has used for a while. Access times cannot stand in for the record: Windows
 * does not update them by default, and a fresh unit is never written to.
 *
 * A unit with no record — built by a plain `cargo` command, or by a workspace
 * that shares the directory without going through this CLI — is only removed
 * once a newer unit of the same crate and kind has replaced it, so a build the
 * CLI never saw is not thrown away just for being old.
 *
 * @format
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';

export const DEFAULT_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The target directory Cargo will build `manifest` into, or `null`.
 *
 * Asked of Cargo rather than worked out here: `CARGO_TARGET_DIR`, the crate's
 * own `.cargo/config.toml` and any parent directory's config all decide it.
 */
export function cargoTargetDirectory(manifest, { cwd, env } = {}) {
  try {
    const metadata = JSON.parse(
      execFileSync(
        'cargo',
        [
          'metadata',
          '--no-deps',
          '--format-version',
          '1',
          '--manifest-path',
          manifest,
        ],
        {
          cwd,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
    return path.resolve(metadata.target_directory);
  } catch {
    return null;
  }
}

/** Where the record of used units lives, inside the target directory. */
export const USAGE_FILE = '.rn-gpui-target-usage.json';

/** `<package>-<hash>`, as Cargo names a unit's fingerprint and build directory. */
const UNIT_DIR = /^(.+)-([0-9a-f]{16})$/u;
/** The hash in a file under `deps/`: `libfoo-<hash>.rlib`, `foo-<hash>.exe`. */
const HASHED_FILE = /-([0-9a-f]{16})(?:\.|$)/u;

/** Whether the collector runs: never in CI, and never when turned off. */
export function targetGcEnabled(env = process.env) {
  return !env.CI && env.RN_GPUI_TARGET_GC !== '0';
}

/** How many days an unused unit is kept, from `RN_GPUI_TARGET_GC_DAYS`. */
export function targetGcMaxAgeDays(env = process.env) {
  const days = Number(env.RN_GPUI_TARGET_GC_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS;
}

/**
 * The usage key of the unit a build output belongs to, or `null`.
 *
 * Keyed by the profile directory and the hash, which together name one unit:
 * `debug/0123456789abcdef`. The hash is shared by the unit's fingerprint
 * directory, its `build/` directory and its files in `deps/`.
 */
export function unitKey(targetDir, file) {
  const parts = path.relative(targetDir, file).split(/[\\/]/u);
  const at = parts.findIndex(part =>
    ['deps', 'build', 'examples', '.fingerprint'].includes(part),
  );
  if (at <= 0 || at + 1 >= parts.length) return null;
  const profile = parts.slice(0, at).join('/');
  const entry = parts[at + 1];
  const match =
    parts[at] === 'build' || parts[at] === '.fingerprint'
      ? UNIT_DIR.exec(entry)
      : HASHED_FILE.exec(entry);
  if (!match) return null;
  const hash = match[match.length - 1];
  return `${profile}/${hash}`;
}

function readUsage(targetDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(targetDir, USAGE_FILE), 'utf8'),
    );
    if (parsed && typeof parsed.units === 'object') return parsed;
  } catch {}
  return { version: 1, units: {} };
}

function writeUsage(targetDir, usage) {
  try {
    fs.writeFileSync(path.join(targetDir, USAGE_FILE), JSON.stringify(usage));
  } catch {
    // The record only makes pruning more precise; a build never fails over it.
  }
}

/** Marks every unit the given build outputs belong to as used `now`. */
export function recordUsage(targetDir, files, now = Date.now()) {
  if (!fs.existsSync(targetDir)) return;
  const usage = readUsage(targetDir);
  for (const file of files) {
    const key = unitKey(targetDir, file);
    if (key) usage.units[key] = now;
  }
  writeUsage(targetDir, usage);
}

/**
 * The profile directories in a target directory: each one holds `.fingerprint`.
 * A host build puts them at `<target>/<profile>`, a cross build at
 * `<target>/<triple>/<profile>`.
 */
function profileDirs(targetDir) {
  const found = [];
  const visit = (relative, depth) => {
    const absolute = path.join(targetDir, relative);
    if (fs.existsSync(path.join(absolute, '.fingerprint'))) {
      found.push(relative);
      return;
    }
    if (depth === 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        visit(path.join(relative, entry.name), depth - 1);
      }
    }
  };
  visit('', 2);
  return found.filter(Boolean);
}

/** The newest modification time of a directory and its direct children. */
function newestMtime(dir) {
  let newest = 0;
  try {
    newest = fs.statSync(dir).mtimeMs;
    for (const entry of fs.readdirSync(dir)) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
      } catch {}
    }
  } catch {}
  return newest;
}

/**
 * The kind of a unit, from its fingerprint: `lib-foo`,
 * `build-script-build-script-build`, `run-build-script-build-script-build`.
 * One package has several units of different kinds, none replacing another.
 */
function unitKind(fingerprintDir) {
  try {
    const json = fs
      .readdirSync(fingerprintDir)
      .find(name => name.endsWith('.json'));
    return json ? json.slice(0, -'.json'.length) : '';
  } catch {
    return '';
  }
}

/**
 * What a prune would remove: units and incremental caches, without touching
 * anything. Pure apart from reading, so it is what the tests exercise.
 */
export function findStale(
  targetDir,
  { now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {},
) {
  const maxAge = maxAgeDays * DAY_MS;
  const usage = readUsage(targetDir);
  const units = [];
  const incremental = [];
  for (const profile of profileDirs(targetDir)) {
    const profileKey = profile.split(path.sep).join('/');
    const fingerprints = path.join(targetDir, profile, '.fingerprint');
    const groups = new Map();
    for (const dirName of fs.readdirSync(fingerprints)) {
      const match = UNIT_DIR.exec(dirName);
      if (!match) continue;
      const fingerprintDir = path.join(fingerprints, dirName);
      const key = `${profileKey}/${match[2]}`;
      const recorded = usage.units[key];
      const unit = {
        profile,
        dirName,
        hash: match[2],
        key,
        recorded,
        lastUsed: recorded ?? newestMtime(fingerprintDir),
      };
      const group = `${match[1]}\u0000${unitKind(fingerprintDir)}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(unit);
    }
    for (const group of groups.values()) {
      const newest = Math.max(...group.map(unit => unit.lastUsed));
      for (const unit of group) {
        if (now - unit.lastUsed <= maxAge) continue;
        // A recorded unit that no build has used for the whole period is
        // stale. One without a record is only stale once something newer of
        // the same crate and kind has taken its place.
        if (unit.recorded != null || unit.lastUsed < newest) units.push(unit);
      }
    }
    const incrementalDir = path.join(targetDir, profile, 'incremental');
    let caches = [];
    try {
      caches = fs.readdirSync(incrementalDir);
    } catch {}
    for (const cache of caches) {
      const cacheDir = path.join(incrementalDir, cache);
      // A session directory is written each time the crate is compiled, so a
      // cache untouched for the period gives the next build nothing to reuse.
      if (now - newestMtime(cacheDir) > maxAge) incremental.push(cacheDir);
    }
  }
  return { units, incremental };
}

function sizeOf(target) {
  let total = 0;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    for (const entry of fs.readdirSync(target)) {
      total += sizeOf(path.join(target, entry));
    }
  } catch {}
  return total;
}

function remove(target) {
  const size = sizeOf(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return size;
  } catch {
    return 0;
  }
}

/** Removes one unit: its fingerprint, its `build/` directory and its files. */
function removeUnit(targetDir, unit) {
  const profileDir = path.join(targetDir, unit.profile);
  let freed = remove(path.join(profileDir, '.fingerprint', unit.dirName));
  freed += remove(path.join(profileDir, 'build', unit.dirName));
  for (const folder of ['deps', 'examples']) {
    const dir = path.join(profileDir, folder);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {}
    for (const entry of entries) {
      const match = HASHED_FILE.exec(entry);
      if (match && match[1] === unit.hash)
        freed += remove(path.join(dir, entry));
    }
  }
  return freed;
}

/**
 * Removes what `findStale` reports, and says how much it freed. Quiet when
 * there was nothing to remove, so an ordinary build prints nothing extra.
 */
export function pruneTarget(
  targetDir,
  {
    now = Date.now(),
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    log = message => console.log(message),
  } = {},
) {
  if (!fs.existsSync(targetDir)) return { units: 0, caches: 0, bytes: 0 };
  const stale = findStale(targetDir, { now, maxAgeDays });
  let bytes = 0;
  for (const unit of stale.units) bytes += removeUnit(targetDir, unit);
  for (const cache of stale.incremental) bytes += remove(cache);
  if (stale.units.length > 0) {
    const usage = readUsage(targetDir);
    for (const unit of stale.units) delete usage.units[unit.key];
    writeUsage(targetDir, usage);
  }
  if (bytes > 0) {
    log(
      `Removed ${stale.units.length} build unit(s) and ` +
        `${stale.incremental.length} incremental cache(s) unused for ` +
        `${maxAgeDays} days from ${targetDir} ` +
        `(${(bytes / 1024 ** 3).toFixed(2)} GB). ` +
        'Set RN_GPUI_TARGET_GC=0 to keep them.',
    );
  }
  return {
    units: stale.units.length,
    caches: stale.incremental.length,
    bytes,
  };
}

/**
 * Runs a Cargo build and records the units it used.
 *
 * `json-render-diagnostics` leaves the diagnostics to Cargo, rendered on stderr
 * as usual, and puts only the build messages on stdout as JSON; anything on
 * stdout that is not one of them — a build script's own output — is passed
 * through. Resolves when Cargo succeeds and rejects when it fails, like the
 * plain invocation it replaces.
 */
export function cargoBuildRecording(args, { cwd, env, targetDir }) {
  const [command, ...rest] = args;
  const cargoArgs = [
    command,
    '--message-format=json-render-diagnostics',
    ...rest,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', cargoArgs, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    const used = [];
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message = null;
      if (line.startsWith('{')) {
        try {
          message = JSON.parse(line);
        } catch {}
      }
      if (message == null || typeof message.reason !== 'string') {
        process.stdout.write(`${line}\n`);
        return;
      }
      if (message.reason === 'compiler-artifact') {
        used.push(...(message.filenames ?? []));
        if (message.executable) used.push(message.executable);
      } else if (message.reason === 'build-script-executed') {
        if (message.out_dir) used.push(message.out_dir);
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`cargo ${cargoArgs.join(' ')} failed with ${code}`));
        return;
      }
      if (targetDir) recordUsage(targetDir, used);
      resolve();
    });
  });
}
