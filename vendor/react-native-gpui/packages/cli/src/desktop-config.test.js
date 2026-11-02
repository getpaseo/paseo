import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  identifierFromName,
  loadDesktopConfig,
  mergePatch,
  targetsFor,
} from './desktop-config.js';

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

/**
 * A minimal app: `app.json` and `package.json` only. `files` adds or replaces
 * files by path relative to the project root.
 */
function createProject({ appJson, packageJson, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-desktop-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app.json'),
    `${JSON.stringify(
      appJson ?? { name: 'MyApp', displayName: 'My App' },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      packageJson ?? { name: 'my-app', version: '2.3.4' },
      null,
      2,
    )}\n`,
  );
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof contents === 'string'
        ? contents
        : JSON.stringify(contents, null, 2),
    );
  }
  return root;
}

describe('defaults', () => {
  test('an app with no desktop.json gets every default', () => {
    const root = createProject();
    const config = loadDesktopConfig(root, 'macos');
    expect(config.productName).toBe('My App');
    expect(config.identifier).toBe('com.example.myapp');
    expect(config.version).toBe('2.3.4');
    expect(config.window).toEqual({
      width: 1024,
      height: 768,
      title: 'My App',
      resizable: true,
      restoreState: true,
    });
    expect(config.devMenu).toBe(true);
    expect(config.tray).toBeUndefined();
    expect(config.bundle.targets).toBe('all');
    expect(config.bundle.resources).toEqual([]);
    expect(config.bundle.macos.minimumSystemVersion).toBe('13.0');
    expect(config.bundle.macos.entitlements).toBeNull();
    expect(config.bundle.macos.infoPlist).toEqual({});
    expect(config.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(config.bundle.linux.deb.depends).toEqual([]);
  });

  test('the window title defaults to productName, not the app name', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': { productName: 'Shiny' } },
    });
    expect(loadDesktopConfig(root, 'macos').window.title).toBe('Shiny');
  });

  test('an explicit title wins over productName', () => {
    const root = createProject({
      files: {
        'desktop/desktop.json': {
          productName: 'Shiny',
          window: { title: 'Other' },
        },
      },
    });
    expect(loadDesktopConfig(root, 'macos').window.title).toBe('Other');
  });

  test('an identifier is derived from the app name when absent', () => {
    const root = createProject({ appJson: { name: 'My_App 2' } });
    expect(loadDesktopConfig(root, 'macos').identifier).toBe(
      'com.example.my-app-2',
    );
    expect(identifierFromName('A B')).toBe('com.example.a-b');
  });
});

describe('per-OS overrides', () => {
  test('desktop.<os>.json is merged over the base', () => {
    const root = createProject({
      files: {
        'desktop/desktop.json': {
          productName: 'Base',
          window: { width: 800, height: 600 },
        },
        'desktop/desktop.macos.json': { window: { width: 1200 } },
      },
    });
    const macos = loadDesktopConfig(root, 'macos');
    expect(macos.productName).toBe('Base');
    expect(macos.window.width).toBe(1200);
    // Untouched keys keep the base value.
    expect(macos.window.height).toBe(600);

    // The override only applies to its own OS.
    expect(loadDesktopConfig(root, 'linux').window.width).toBe(800);
  });

  test('a null removes a key, as RFC 7386 says', () => {
    const root = createProject({
      files: {
        'desktop/desktop.json': {
          tray: { component: 'MyTray', tooltip: 'Hi' },
        },
        'desktop/desktop.linux.json': { tray: null },
      },
    });
    expect(loadDesktopConfig(root, 'macos').tray).toEqual({
      component: 'MyTray',
      tooltip: 'Hi',
      accessory: true,
    });
    expect(loadDesktopConfig(root, 'linux').tray).toBeUndefined();
  });

  test('mergePatch replaces arrays rather than concatenating them', () => {
    expect(
      mergePatch(
        { bundle: { resources: ['a', 'b'] } },
        { bundle: { resources: ['c'] } },
      ),
    ).toEqual({ bundle: { resources: ['c'] } });
  });

  test('merging into a missing base fills from the override alone', () => {
    expect(mergePatch(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });
});

describe('validation', () => {
  test('an unknown key is refused with its JSON path', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': { windo: { width: 1 } } },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /\$\.windo: unknown key; known keys are/,
    );
  });

  test('a wrong type names the offending path', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': { window: { width: 'wide' } } },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /\$\.window\.width: expected number/,
    );
  });

  test('a nested unknown key is caught too', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': { bundle: { macos: { nope: 1 } } } },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /\$\.bundle\.macos\.nope: unknown key/,
    );
  });

  test('two problems are both reported', () => {
    const root = createProject({
      files: {
        'desktop/desktop.json': {
          window: { width: 'wide' },
          version: 7,
        },
      },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /window\.width: expected number[\s\S]*\$\.version: expected string/,
    );
  });

  test('a bad target is refused with the allowed list', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': { bundle: { targets: ['msi'] } } },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /\$\.bundle\.targets: (matches 0 of|unknown bundle target)/,
    );
  });

  test('a target for another OS is refused by targetsFor, with what is available', () => {
    // The schema allows any known format, because which ones an OS can build is
    // a fact about the OS rather than about the file.
    const root = createProject({
      files: { 'desktop/desktop.json': { bundle: { targets: ['nsis'] } } },
    });
    const config = loadDesktopConfig(root, 'macos');
    expect(() => targetsFor(config, 'macos')).toThrow(
      /nsis cannot be built on macos; available targets are app, dmg/,
    );
  });

  test('a file that is not JSON says so', () => {
    const root = createProject({
      files: { 'desktop/desktop.json': '{ nope' },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      /desktop\/desktop\.json is not valid JSON/,
    );
  });
});

describe('secrets', () => {
  test.each([
    ['a password', { bundle: { macos: { password: 'hunter2' } } }],
    ['a top-level secret', { secret: 'abc' }],
    ['a token', { bundle: { windows: { token: 'abc' } } }],
    ['a private key', { bundle: { macos: { privateKey: '---' } } }],
    ['an oddly-cased name', { bundle: { macos: { PASSWORD: 'x' } } }],
  ])('%s is refused, and its value is not printed', (_name, config) => {
    const root = createProject({ files: { 'desktop/desktop.json': config } });
    let message = '';
    try {
      loadDesktopConfig(root, 'macos');
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/must not contain signing material/);
    // Printing a leaked secret into a build log is the same mistake twice.
    expect(message).not.toMatch(/hunter2|abc|---/u);
  });

  test('a key that merely resembles one is allowed', () => {
    // `InfoPlist` contains "Plist", not a secret word; the check must not be so
    // eager that it refuses the documented `infoPlist` setting.
    const root = createProject({
      files: {
        'desktop/desktop.json': { bundle: { macos: { infoPlist: {} } } },
      },
    });
    expect(() => loadDesktopConfig(root, 'macos')).not.toThrow();
  });
});

describe('the app.json migration', () => {
  test('a non-empty app.json desktop key is refused with the migration', () => {
    const root = createProject({
      appJson: { name: 'MyApp', desktop: { appId: 'com.example.app' } },
    });
    expect(() => loadDesktopConfig(root, 'macos')).toThrow(
      'move `app.json` desktop.* into `desktop/desktop.json` (see the README)',
    );
  });

  test('an empty app.json desktop key is tolerated', () => {
    const root = createProject({
      appJson: { name: 'MyApp', desktop: {} },
    });
    expect(() => loadDesktopConfig(root, 'macos')).not.toThrow();
  });

  test('no app.json desktop key at all is fine', () => {
    const root = createProject();
    expect(() => loadDesktopConfig(root, 'macos')).not.toThrow();
  });
});

describe('targetsFor', () => {
  const config = targets => ({ bundle: { targets } });

  test("'all' expands to the current OS's alpha formats", () => {
    expect(targetsFor(config('all'), 'macos')).toEqual(['app', 'dmg']);
    expect(targetsFor(config('all'), 'windows')).toEqual(['nsis']);
    expect(targetsFor(config('all'), 'linux')).toEqual(['deb', 'appimage']);
  });

  test('an explicit list is filtered to what the OS can build', () => {
    expect(targetsFor(config(['app']), 'macos')).toEqual(['app']);
  });

  test('an unknown format names every allowed one', () => {
    expect(() => targetsFor(config(['msi']), 'macos')).toThrow(
      /unknown bundle target\(s\) msi; expected one of app, dmg, nsis, deb, appimage or 'all'/,
    );
  });
});
