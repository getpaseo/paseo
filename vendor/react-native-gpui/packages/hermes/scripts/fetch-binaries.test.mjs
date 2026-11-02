import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  binRootFrom,
  installedState,
  recordedSource,
  repositoryFromManifest,
  selectedPlatforms,
  writeRecordedSource,
} from './fetch-binaries.mjs';

const RELEASE = '@react-native-gpui/hermes@0.1.1';
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('repositoryFromManifest', () => {
  test('reads the string form', () => {
    expect(
      repositoryFromManifest({ repository: 'streetwriters/react-native-gpui' }),
    ).toBe('streetwriters/react-native-gpui');
  });

  test('reads the object form', () => {
    expect(
      repositoryFromManifest({
        repository: {
          type: 'git',
          url: 'https://github.com/streetwriters/react-native-gpui',
        },
      }),
    ).toBe('streetwriters/react-native-gpui');
  });

  test('strips git+, the GitHub URL, .git and a directory field', () => {
    expect(
      repositoryFromManifest({
        repository: {
          type: 'git',
          url: 'git+https://github.com/streetwriters/react-native-gpui.git',
          directory: 'packages/hermes',
        },
      }),
    ).toBe('streetwriters/react-native-gpui');
  });

  test('is unaffected by GITHUB_REPOSITORY, which points at a fork in CI', () => {
    const env = { GITHUB_REPOSITORY: 'someone/else' };
    expect(
      repositoryFromManifest(
        { repository: 'https://github.com/streetwriters/react-native-gpui' },
        env,
      ),
    ).toBe('streetwriters/react-native-gpui');
    expect(env.GITHUB_REPOSITORY).toBe('someone/else');
  });

  test('RN_GPUI_HERMES_REPO overrides the manifest, for mirrors', () => {
    expect(
      repositoryFromManifest(
        { repository: 'https://github.com/streetwriters/react-native-gpui' },
        { RN_GPUI_HERMES_REPO: 'https://example.test/mirror' },
      ),
    ).toBe('https://example.test/mirror');
  });

  test('names the manifest when there is no usable repository', () => {
    expect(() => repositoryFromManifest({ name: 'hermes' })).toThrow(
      /could not read the repository/u,
    );
  });
});

describe('binRootFrom', () => {
  test('defaults to the package bin directory', () => {
    expect(binRootFrom({})).toBe(path.join(packageRoot, 'bin'));
  });

  test('honours RN_GPUI_HERMES_BIN_ROOT, which CMake also reads', () => {
    // CMake's desktop/CMakeLists.txt and desktop/node-api-exports.test.js both accept
    // this variable. When the downloader ignored it, the binaries landed in the
    // package while the build looked elsewhere, and configure failed with
    // "Hermes library not found".
    expect(binRootFrom({ RN_GPUI_HERMES_BIN_ROOT: '/tmp/hermes-bin' })).toBe(
      '/tmp/hermes-bin',
    );
  });
});

describe('selectedPlatforms', () => {
  test('honours --platform on any host', () => {
    expect(selectedPlatforms({ platform: 'darwin-x64' })).toEqual([
      'darwin-x64',
    ]);
    expect(selectedPlatforms({ platform: 'win32-arm64' })).toEqual([
      'win32-arm64',
    ]);
  });

  test('--all lists every platform', () => {
    expect(selectedPlatforms({ all: true })).toHaveLength(6);
  });
});

describe('installedState', () => {
  const roots = [];
  const tempRoot = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));
    roots.push(root);
    return root;
  };
  const install = (root, platform, files) => {
    mkdirSync(path.join(root, platform), { recursive: true });
    for (const file of files) {
      writeFileSync(path.join(root, platform, file), 'binary');
    }
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test('a complete directory with no .release is stale', () => {
    const root = tempRoot();
    install(root, 'darwin-arm64', ['libhermesvm.dylib', 'hermesc']);
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'stale',
    });
  });

  test('a matching .release is current', () => {
    const root = tempRoot();
    install(root, 'darwin-arm64', ['libhermesvm.dylib', 'hermesc']);
    writeRecordedSource('darwin-arm64', RELEASE, root);
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'current',
    });
    expect(recordedSource('darwin-arm64', root)).toBe(RELEASE);
  });

  test('a different tag is stale, so a version bump replaces the binaries', () => {
    const root = tempRoot();
    install(root, 'darwin-arm64', ['libhermesvm.dylib', 'hermesc']);
    writeRecordedSource(
      'darwin-arm64',
      '@react-native-gpui/hermes@0.1.0',
      root,
    );
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'stale',
    });
  });

  test('a hand-installed source is foreign, and must be kept', () => {
    const root = tempRoot();
    install(root, 'darwin-arm64', ['libhermesvm.dylib', 'hermesc']);
    writeRecordedSource('darwin-arm64', 'from:/tmp/my-build.zip', root);
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'foreign',
      source: 'from:/tmp/my-build.zip',
    });
  });

  test('a run source is foreign too', () => {
    const root = tempRoot();
    install(root, 'win32-x64', ['hermesvm.dll', 'hermesvm.lib', 'hermesc.exe']);
    writeRecordedSource('win32-x64', 'run:12345', root);
    expect(installedState('win32-x64', RELEASE, root)).toEqual({
      state: 'foreign',
      source: 'run:12345',
    });
  });

  test('missing files win over a recorded source', () => {
    const root = tempRoot();
    install(root, 'darwin-arm64', ['libhermesvm.dylib']);
    writeRecordedSource('darwin-arm64', RELEASE, root);
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'missing',
    });
  });

  test('an empty directory is missing', () => {
    const root = tempRoot();
    expect(installedState('darwin-arm64', RELEASE, root)).toEqual({
      state: 'missing',
    });
  });
});

describe('the CLI entry point', () => {
  const script = fileURLToPath(
    new URL('./fetch-binaries.mjs', import.meta.url),
  );
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test('runs when reached through a path that differs from its real one', () => {
    // A CMake build under /tmp is reached as /private/tmp, and os.tmpdir() is
    // itself a symlink on macOS. Comparing unresolved paths made the script
    // exit 0 without doing anything, which a missing Hermes library turned
    // into a link error much later.
    const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-entry-'));
    roots.push(root);
    const scripts = path.join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(script, path.join(scripts, 'fetch-binaries.mjs'));
    const linked = path.join(root, 'linked');
    // A directory symlink needs an elevated process or Developer Mode on
    // Windows; a junction needs neither, and `realpathSync` resolves it to the
    // same target, which is the behaviour under test.
    symlinkSync(
      scripts,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const invoked = path.join(linked, 'fetch-binaries.mjs');
    expect(realpathSync(invoked)).not.toBe(invoked);

    const output = execFileSync(process.execPath, [invoked, '--help'], {
      encoding: 'utf8',
    });
    expect(output).toContain('Usage: node scripts/fetch-binaries.mjs');
  });

  test('does nothing when it is imported rather than run', () => {
    // The import at the top of this file is the test: reaching this point
    // without a download proves the guard holds.
    expect(typeof repositoryFromManifest).toBe('function');
  });
});
