import { afterEach, beforeEach, describe, expect, test } from 'vitest';

/**
 * `Platform.OS` and `Platform.constants.systemName` have to answer for the
 * host the bundle is running on, and they have to answer on the *first* read:
 * a bundle whose first line asks for the host cannot be told the wrong one.
 *
 * The module under test imports `TurboModuleRegistry` from the `react-native`
 * package root, which the vitest preset aliases to a mock — React Native's own
 * entry is Flow-typed and cannot be parsed here. What the native side reports is
 * installed through `globalThis.__rnGpuiTestTurboModules`, which that mock reads
 * on every call.
 */
const registry = new Map();

function desktopReporting(platform) {
  registry.set('GpuiDesktop', { platform: () => platform });
}

function platformConstantsReporting(jsEngine) {
  registry.set('PlatformConstants', {
    getConstants: () => ({ jsEngine }),
  });
}

/**
 * The module under test is a singleton with two cache fields (`__OS`,
 * `__constants`). Every test wants it as a bundle would see it on first use, so
 * those fields are cleared rather than the module re-imported — re-importing
 * would need `vi.resetModules()`, which also clears the alias.
 */
let platform;

beforeEach(async () => {
  registry.clear();
  globalThis.__rnGpuiTestTurboModules = registry;
  platform ??= (await import('./Platform.desktop.js')).default;
  platform.__OS = null;
  platform.__constants = null;
});

afterEach(() => {
  registry.clear();
  delete globalThis.__rnGpuiTestTurboModules;
});

describe('Platform.OS', () => {
  test('answers on the first read, before anything reads constants', () => {
    desktopReporting('windows');
    // Deliberately no `Platform.constants` read first: this is the case that
    // reported macOS on every host.
    expect(platform.OS).toBe('windows');
  });

  test('reports each host the native module can name', () => {
    for (const os of ['macos', 'windows', 'linux']) {
      registry.clear();
      desktopReporting(os);
      platform.__OS = null;
      expect(platform.OS).toBe(os);
    }
  });

  test('retries a failed lookup on the next read instead of caching the miss', () => {
    // Nothing installed yet: the documented fallback, not a cached answer.
    expect(platform.OS).toBe('macos');

    desktopReporting('windows');
    expect(platform.OS).toBe('windows');
  });

  test('keeps the first real answer it gets', () => {
    desktopReporting('linux');
    expect(platform.OS).toBe('linux');

    // A host cannot change under a running bundle, and a later transient failure
    // must not overwrite what was already reported.
    registry.clear();
    expect(platform.OS).toBe('linux');
  });

  test('agrees with constants when constants is read first', () => {
    desktopReporting('linux');
    platformConstantsReporting({ name: 'hermes', version: '1' });

    expect(platform.constants.systemName).toBe('Linux');
    expect(platform.OS).toBe('linux');
  });
});

describe('Platform.constants.systemName', () => {
  test('names the real host rather than always macOS', () => {
    for (const [os, expected] of [
      ['macos', 'macOS'],
      ['windows', 'Windows'],
      ['linux', 'Linux'],
    ]) {
      registry.clear();
      desktopReporting(os);
      platform.__OS = null;
      platform.__constants = null;
      expect(platform.constants.systemName).toBe(expected);
    }
  });

  test('is still macOS-shaped when the module cannot answer', () => {
    // The fallback keeps the value a documented spelling, so a caller that
    // switches on it cannot receive an unknown string.
    expect(platform.constants.systemName).toBe('macOS');
  });
});

describe('Platform.constants host values', () => {
  test('osVersion and isTesting come from the desktop module', () => {
    registry.set('GpuiDesktop', {
      platform: () => 'linux',
      platformConstants: () => ({ osVersion: '24.04', isTesting: true }),
    });
    platformConstantsReporting({ name: 'hermes', version: '1' });

    expect(platform.Version).toBe('24.04');
    expect(platform.constants.osVersion).toBe('24.04');
    expect(platform.isTesting).toBe(true);
  });

  test('falls back to unknown without caching until the module answers', () => {
    platformConstantsReporting({ name: 'hermes', version: '1' });
    expect(platform.Version).toBe('unknown');
    expect(platform.isTesting).toBe(false);

    registry.set('GpuiDesktop', {
      platform: () => 'macos',
      platformConstants: () => ({ osVersion: '15.1', isTesting: false }),
    });
    expect(platform.Version).toBe('15.1');
  });
});

describe('Platform.select', () => {
  test('picks the running OS, then native, then default', () => {
    desktopReporting('linux');
    expect(platform.select({ linux: 1, macos: 2, default: 3 })).toBe(1);
    expect(platform.select({ macos: 2, native: 4, default: 3 })).toBe(4);
    expect(platform.select({ windows: 2, default: 3 })).toBe(3);
  });

  test('prefers desktop over native, and the OS over both', () => {
    desktopReporting('linux');
    // A platform-specific key ranks first, then `desktop`, then `native`.
    expect(platform.select({ linux: 1, desktop: 2, native: 3 })).toBe(1);
    expect(platform.select({ macos: 1, desktop: 2, native: 3 })).toBe(2);
    expect(platform.select({ macos: 1, native: 3, default: 4 })).toBe(3);
    expect(platform.select({ desktop: 2, default: 4 })).toBe(2);
    expect(platform.select({ ios: 5, android: 6 })).toBe(5);
    expect(platform.select({ android: 6 })).toBeUndefined();
  });
});
