import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  USAGE_FILE,
  findStale,
  pruneTarget,
  recordUsage,
  targetGcEnabled,
  targetGcMaxAgeDays,
  unitKey,
} from './target-gc.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 24);
const HASH_A = '0123456789abcdef';
const HASH_B = 'fedcba9876543210';
const HASH_C = '00112233445566ff';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function targetDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-target-gc-'));
  roots.push(root);
  return root;
}

function write(file, contents = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function age(target, daysOld) {
  const time = new Date(NOW - daysOld * DAY);
  fs.utimesSync(target, time, time);
}

/**
 * One unit as Cargo lays it out: a fingerprint whose `.json` names its kind, a
 * library in `deps/`, and for a build script its `build/` directory.
 */
function unit(
  target,
  { name, hash, kind = `lib-${name}`, daysOld, profile = 'debug' },
) {
  const profileDir = path.join(target, profile);
  const fingerprint = path.join(profileDir, '.fingerprint', `${name}-${hash}`);
  write(path.join(fingerprint, kind));
  write(path.join(fingerprint, `${kind}.json`), '{}');
  const crate = name.replaceAll('-', '_');
  write(path.join(profileDir, 'deps', `lib${crate}-${hash}.rlib`), 'rlib');
  write(path.join(profileDir, 'deps', `${crate}-${hash}.d`));
  if (kind.includes('build-script')) {
    write(
      path.join(profileDir, 'build', `${name}-${hash}`, 'out', 'generated.rs'),
    );
  }
  for (const entry of fs.readdirSync(fingerprint)) {
    age(path.join(fingerprint, entry), daysOld);
  }
  age(fingerprint, daysOld);
  return { profileDir, fingerprint, crate };
}

describe('unitKey', () => {
  test('names a unit by its profile and hash, from any of its outputs', () => {
    const target = targetDir();
    expect(
      unitKey(
        target,
        path.join(target, 'debug', 'deps', `libserde-${HASH_A}.rlib`),
      ),
    ).toBe(`debug/${HASH_A}`);
    expect(
      unitKey(
        target,
        path.join(target, 'debug', 'build', `rn-gpui-sys-${HASH_B}`, 'out'),
      ),
    ).toBe(`debug/${HASH_B}`);
    // A cross build nests the profile under the target triple.
    expect(
      unitKey(
        target,
        path.join(
          target,
          'x86_64-pc-windows-msvc',
          'release',
          'deps',
          `foo-${HASH_C}.dll`,
        ),
      ),
    ).toBe(`x86_64-pc-windows-msvc/release/${HASH_C}`);
  });

  test('an uplifted binary belongs to no unit', () => {
    const target = targetDir();
    expect(unitKey(target, path.join(target, 'debug', 'app.exe'))).toBeNull();
  });
});

describe('pruning', () => {
  test('a recorded unit no build used for the period is removed, with its files', () => {
    const target = targetDir();
    const old = unit(target, { name: 'serde', hash: HASH_A, daysOld: 30 });
    unit(target, { name: 'log', hash: HASH_B, daysOld: 30 });
    recordUsage(
      target,
      [path.join(old.profileDir, 'deps', `libserde-${HASH_A}.rlib`)],
      NOW - 10 * DAY,
    );
    recordUsage(
      target,
      [path.join(old.profileDir, 'deps', `liblog-${HASH_B}.rlib`)],
      NOW - DAY,
    );

    const result = pruneTarget(target, {
      now: NOW,
      maxAgeDays: 7,
      log: () => {},
    });

    expect(result.units).toBe(1);
    expect(fs.existsSync(old.fingerprint)).toBe(false);
    expect(
      fs.existsSync(
        path.join(old.profileDir, 'deps', `libserde-${HASH_A}.rlib`),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(old.profileDir, 'deps', `serde-${HASH_A}.d`)),
    ).toBe(false);
    // Used yesterday, so kept, and its record survives.
    expect(
      fs.existsSync(path.join(old.profileDir, 'deps', `liblog-${HASH_B}.rlib`)),
    ).toBe(true);
    const usage = JSON.parse(
      fs.readFileSync(path.join(target, USAGE_FILE), 'utf8'),
    );
    expect(Object.keys(usage.units)).toEqual([`debug/${HASH_B}`]);
  });

  test('an old unit without a record is kept while it is the only one of its kind', () => {
    // Built by a plain `cargo` command the CLI never saw: old is not enough.
    const target = targetDir();
    unit(target, { name: 'gpui', hash: HASH_A, daysOld: 60 });
    expect(findStale(target, { now: NOW, maxAgeDays: 7 }).units).toEqual([]);
  });

  test('an old unit without a record goes once a newer one of the same kind replaced it', () => {
    const target = targetDir();
    unit(target, { name: 'rn-gpui-sys', hash: HASH_A, daysOld: 30 });
    unit(target, { name: 'rn-gpui-sys', hash: HASH_B, daysOld: 1 });
    const stale = findStale(target, { now: NOW, maxAgeDays: 7 });
    expect(stale.units.map(staleUnit => staleUnit.hash)).toEqual([HASH_A]);
  });

  test("a package's build-script units are not replaced by its library", () => {
    // One package has a library, a build script and the build script's run,
    // each its own unit. The library being newer replaces none of the others.
    const target = targetDir();
    const name = 'rn-gpui-sys';
    unit(target, {
      name,
      hash: HASH_A,
      daysOld: 30,
      kind: 'build-script-build-script-build',
    });
    unit(target, {
      name,
      hash: HASH_B,
      daysOld: 30,
      kind: 'run-build-script-build-script-build',
    });
    unit(target, { name, hash: HASH_C, daysOld: 1 });
    expect(findStale(target, { now: NOW, maxAgeDays: 7 }).units).toEqual([]);
  });

  test('an incremental cache untouched for the period is removed', () => {
    const target = targetDir();
    unit(target, { name: 'app', hash: HASH_A, daysOld: 1 });
    const incremental = path.join(target, 'debug', 'incremental');
    write(path.join(incremental, 'app-old', 's-session', 'query-cache.bin'));
    age(path.join(incremental, 'app-old', 's-session'), 20);
    age(path.join(incremental, 'app-old'), 20);
    write(path.join(incremental, 'app-new', 's-session', 'query-cache.bin'));
    age(path.join(incremental, 'app-new', 's-session'), 0);
    age(path.join(incremental, 'app-new'), 0);

    pruneTarget(target, { now: NOW, maxAgeDays: 7, log: () => {} });

    expect(fs.existsSync(path.join(incremental, 'app-old'))).toBe(false);
    expect(fs.existsSync(path.join(incremental, 'app-new'))).toBe(true);
  });

  test('a missing target directory is a no-op', () => {
    const target = path.join(targetDir(), 'never-built');
    expect(pruneTarget(target, { now: NOW, log: () => {} })).toEqual({
      units: 0,
      caches: 0,
      bytes: 0,
    });
  });
});

describe('configuration', () => {
  test('never runs in CI, and can be turned off', () => {
    expect(targetGcEnabled({})).toBe(true);
    expect(targetGcEnabled({ CI: 'true' })).toBe(false);
    expect(targetGcEnabled({ RN_GPUI_TARGET_GC: '0' })).toBe(false);
  });

  test('keeps units for a week unless told otherwise', () => {
    expect(targetGcMaxAgeDays({})).toBe(7);
    expect(targetGcMaxAgeDays({ RN_GPUI_TARGET_GC_DAYS: '14' })).toBe(14);
    expect(targetGcMaxAgeDays({ RN_GPUI_TARGET_GC_DAYS: 'nope' })).toBe(7);
  });
});
