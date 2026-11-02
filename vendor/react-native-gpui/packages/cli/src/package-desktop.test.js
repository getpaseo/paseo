import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildLibraryDirectories,
  CARGO_PACKAGER_VERSION,
  SIGNING_ENVIRONMENT,
  libraryExtension,
  parseSharedLibraryReferences,
  recordedLibraryDirectories,
  releaseLibraryDirectories,
  resolveLinkedLibraryForTest,
  runtimeLibraries,
  targetProfileDir,
  toPackagerConfig,
} from './package-desktop.js';

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

/** A project with an autolink manifest and whatever files are asked for. */
function createProject({ engines = [], files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-package-'));
  roots.push(root);
  write(root, 'package.json', { name: 'my-app' });
  if (engines.length > 0) {
    write(root, 'desktop/autolink/autolink.json', { jsEngines: engines });
  }
  for (const [relative, contents] of Object.entries(files)) {
    write(root, relative, contents);
  }
  return root;
}

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof contents === 'string'
      ? contents
      : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

describe('libraryExtension', () => {
  test('each OS has its own shared-library extension', () => {
    expect(libraryExtension('macos')).toBe('.dylib');
    expect(libraryExtension('windows')).toBe('.dll');
    expect(libraryExtension('linux')).toBe('.so');
  });
});

describe('runtimeLibraries', () => {
  test('an engine that names its own files is read from its module', () => {
    const root = createProject();
    const engineDir = path.join(root, 'engine');
    fs.mkdirSync(engineDir, { recursive: true });
    const library = path.join(engineDir, 'libhermesvm.dylib');
    fs.writeFileSync(library, 'x');
    fs.writeFileSync(
      path.join(engineDir, 'runtime-files.js'),
      `const path = require('node:path');
       module.exports = (platform) =>
         platform === 'darwin' ? [path.join(__dirname, 'libhermesvm.dylib')] : [];
      `,
    );
    write(root, 'desktop/autolink/autolink.json', {
      jsEngines: [
        {
          name: 'hermes',
          runtimeFiles: path.join(engineDir, 'runtime-files.js'),
        },
      ],
    });

    // The engine resolves its own directory, which on macOS reaches the same
    // file through the `/var` -> `/private/var` symlink.
    const libs = runtimeLibraries(root, { os: 'darwin', arch: 'arm64' });
    expect(libs.map(file => fs.realpathSync(file))).toContain(
      fs.realpathSync(library),
    );
  });

  test('a library the engine does not name for this platform is skipped', () => {
    const root = createProject();
    const engineDir = path.join(root, 'engine');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'libhermesvm.dylib'), 'x');
    fs.writeFileSync(
      path.join(engineDir, 'runtime-files.js'),
      `const path = require('node:path');
       module.exports = (platform) =>
         platform === 'darwin' ? [path.join(__dirname, 'libhermesvm.dylib')] : [];
      `,
    );
    write(root, 'desktop/autolink/autolink.json', {
      jsEngines: [
        {
          name: 'hermes',
          runtimeFiles: path.join(engineDir, 'runtime-files.js'),
        },
      ],
    });

    expect(runtimeLibraries(root, { os: 'win32', arch: 'x64' })).toEqual([]);
  });

  test('shared libraries the build produced are found beside the target', () => {
    const root = createProject();
    write(root, 'desktop/target/release/libruntime.dylib', 'x');
    write(root, 'desktop/target/release/notes.txt', 'not a library');
    const libs = runtimeLibraries(root, { os: 'darwin', arch: 'arm64' });
    expect(libs.map(file => path.basename(file))).toEqual(['libruntime.dylib']);
  });

  test('the sys crate build output is scanned, keyed by its hash', () => {
    const root = createProject();
    write(
      root,
      'desktop/target/release/build/rn-gpui-sys-abc123/out/libjsi.dylib',
      'x',
    );
    const libs = runtimeLibraries(root, { os: 'darwin', arch: 'arm64' });
    expect(libs.map(file => path.basename(file))).toEqual(['libjsi.dylib']);
  });

  test('a versioned Linux library counts as a library', () => {
    const root = createProject();
    write(root, 'desktop/target/release/libfoo.so.1.2.3', 'x');
    write(root, 'desktop/target/release/libfoo.so', 'x');
    const libs = runtimeLibraries(root, { os: 'linux', arch: 'x64' });
    expect(libs.map(file => path.basename(file)).sort()).toEqual([
      'libfoo.so',
      'libfoo.so.1.2.3',
    ]);
  });

  test('a library for another OS is not shipped', () => {
    const root = createProject();
    write(root, 'desktop/target/release/libfoo.dylib', 'x');
    expect(runtimeLibraries(root, { os: 'win32', arch: 'x64' })).toEqual([]);
  });

  test('a debug build reads the debug profile', () => {
    const root = createProject();
    write(root, 'desktop/target/debug/libruntime.dylib', 'x');
    write(root, 'desktop/target/release/librelease.dylib', 'x');
    expect(
      runtimeLibraries(root, {
        os: 'darwin',
        arch: 'arm64',
        release: false,
      }).map(file => path.basename(file)),
    ).toEqual(['libruntime.dylib']);
  });

  test('a project with no autolink manifest ships no engine files', () => {
    const root = createProject();
    expect(runtimeLibraries(root, { os: 'darwin', arch: 'arm64' })).toEqual([]);
  });

  test('the same library named twice is shipped once', () => {
    const root = createProject();
    write(root, 'desktop/target/release/libfoo.dylib', 'x');
    const libs = runtimeLibraries(root, { os: 'darwin', arch: 'arm64' });
    expect(new Set(libs).size).toBe(libs.length);
  });
});

describe('buildLibraryDirectories', () => {
  test('the release and debug profiles are distinct', () => {
    const root = createProject();
    expect(buildLibraryDirectories(root, { release: true })[0]).toContain(
      path.join('desktop', 'target', 'release'),
    );
    expect(buildLibraryDirectories(root, { release: false })[0]).toContain(
      path.join('desktop', 'target', 'debug'),
    );
  });
});

// The translator is the whole reason cargo-packager is an implementation
// detail: these hold what it emits for one config, so replacing the packager
// only changes one function and one set of expectations.
test('every package ships an icon', () => {
  // cargo-packager's AppImage step refuses to build without a square icon, so
  // the CLI always supplies one: the app's, or its own placeholder. An app that
  // never set `icon` still packages every format.
  const withIcon = icons =>
    toPackagerConfig(
      {
        productName: 'A',
        identifier: 'com.a.b',
        version: '1.0.0',
        bundle: {
          resources: [],
          macos: { minimumSystemVersion: '13.0', entitlements: null },
          windows: {},
          linux: { deb: { depends: [] }, appimage: {} },
        },
      },
      { crateDir: '/p/desktop', binaryName: 'a', icons },
    );

  expect(withIcon(['build/icons/icon.png']).icons).toEqual([
    'build/icons/icon.png',
  ]);
  expect(withIcon(['assets/icon.png']).icons).toEqual(['assets/icon.png']);
});

test('the packager version is pinned to one release', () => {
  // The translator emits this version's schema, and `ensureCargoPackager`
  // installs it, so the two cannot drift apart.
  expect(CARGO_PACKAGER_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
});

describe('toPackagerConfig', () => {
  const desktopConfig = overrides => {
    const { bundle: bundleOverrides, ...rest } = overrides ?? {};
    return {
      productName: 'My App',
      identifier: 'com.example.myapp',
      version: '1.2.3',
      window: { width: 1024, height: 768 },
      devMenu: true,
      ...rest,
      bundle: {
        targets: 'all',
        resources: [],
        macos: {
          minimumSystemVersion: '13.0',
          entitlements: null,
          infoPlist: {},
        },
        windows: { nsis: { installMode: 'currentUser' } },
        linux: { deb: { depends: [] }, appimage: {} },
        ...bundleOverrides,
      },
    };
  };
  const build = overrides => ({
    crateDir: '/project/desktop',
    binaryName: 'my-app',
    formats: ['app', 'dmg'],
    ...overrides,
  });

  test('a minimal app gives the fields cargo-packager needs', () => {
    const config = toPackagerConfig(desktopConfig(), build());
    expect(config.productName).toBe('My App');
    expect(config.identifier).toBe('com.example.myapp');
    expect(config.version).toBe('1.2.3');
    expect(config.binariesDir).toBe('/project/desktop/target/release');
    expect(config.binaries).toEqual([{ path: 'my-app', main: true }]);
    expect(config.formats).toEqual(['app', 'dmg']);
    expect(config.outDir).toBe('/project/desktop/build/dist');
  });

  test('the bundle file and the assets directory ship as resources', () => {
    // A directory containing this run's output cannot be shipped, so the two
    // are named. The asset directory has to exist to be listed.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-res-'));
    roots.push(root);
    const crateDir = path.join(root, 'desktop');
    fs.mkdirSync(path.join(crateDir, 'build', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(crateDir, 'build', 'index.bundle'), 'x');
    const config = toPackagerConfig(
      desktopConfig(),
      build({
        crateDir,
        bundleDir: path.join(crateDir, 'build'),
        assetsDir: path.join(crateDir, 'build', 'assets'),
      }),
    );
    expect(config.resources).toEqual(['build/index.bundle', 'build/assets']);
  });

  test('a missing staged bundle is an error, not a silent omission', () => {
    // A package without its bundle starts and then dies on a machine with no
    // build tree, so the failure belongs here rather than at first launch.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-res-'));
    roots.push(root);
    const crateDir = path.join(root, 'desktop');
    fs.mkdirSync(path.join(crateDir, 'build'), { recursive: true });
    expect(() =>
      toPackagerConfig(
        desktopConfig(),
        build({ crateDir, bundleDir: path.join(crateDir, 'build') }),
      ),
    ).toThrow(/staged bundle is missing/u);
  });

  test('extra resources are relative to the crate', () => {
    const config = toPackagerConfig(
      desktopConfig({ bundle: { resources: ['extra/data.json'] } }),
      build(),
    );
    expect(config.resources).toEqual(['extra/data.json']);
  });

  test('runtime libraries become macOS frameworks, by source path', () => {
    // cargo-packager copies each entry into Contents/Frameworks itself, so the
    // entry is where the library is, not where it lands.
    const config = toPackagerConfig(
      desktopConfig(),
      build({ libraries: ['/project/desktop/build/libjsi.dylib'] }),
    );
    expect(config.macos.frameworks).toEqual([
      '/project/desktop/build/libjsi.dylib',
    ]);
  });

  test('runtime libraries get the directory each Linux format searches', () => {
    // The deb installs to `usr/lib/<app>`, where the binary's
    // `$ORIGIN/../lib/<app>` rpath looks. The AppImage needs flat `usr/lib`,
    // which is what AppRun puts on the library path and where linuxdeploy looks
    // when resolving the executable's dependencies.
    const config = toPackagerConfig(
      desktopConfig(),
      build({ rpathDir: 'My App', libraries: ['/build/libjsi.so'] }),
    );
    // `rpathDir` is the app name the rpath names, not the crate name: the
    // libraries have to land where the binary actually looks.
    expect(config.deb.files).toEqual({
      '/build/libjsi.so': '/usr/lib/My App/libjsi.so',
    });
    expect(config.appimage.files).toEqual({
      '/build/libjsi.so': '/usr/lib/libjsi.so',
    });
  });

  test('Windows ships the DLLs as resources', () => {
    // NSIS installs the binary and the resources, not the profile directory
    // beside the executable, so the DLLs have to be resources or they are left
    // behind and the app fails to start.
    const config = toPackagerConfig(
      desktopConfig(),
      build({
        os: 'windows',
        crateDir: '/project/desktop',
        libraries: ['/project/desktop/build/hermesvm.dll'],
      }),
    );
    expect(config.resources).toContain('build/hermesvm.dll');
  });

  test('macOS and Linux do not ship libraries as resources', () => {
    for (const platform of ['macos', 'linux']) {
      const config = toPackagerConfig(
        desktopConfig(),
        build({
          os: platform,
          libraries: ['/project/desktop/build/libjsi.dylib'],
        }),
      );
      expect(config.resources).not.toContain('build/libjsi.dylib');
    }
  });

  test('no libraries means no empty framework or files block', () => {
    const config = toPackagerConfig(desktopConfig(), build());
    expect(config.macos.frameworks).toBeUndefined();
    expect(config.deb).toBeUndefined();
    expect(config.appimage).toBeUndefined();
  });

  test('the NSIS install mode is carried over', () => {
    const config = toPackagerConfig(
      desktopConfig({
        bundle: { windows: { nsis: { installMode: 'perMachine' } } },
      }),
      build({ formats: ['nsis'] }),
    );
    expect(config.nsis).toEqual({ installMode: 'perMachine' });
  });

  test('Debian dependencies are carried over', () => {
    const config = toPackagerConfig(
      desktopConfig({
        bundle: { linux: { deb: { depends: ['libgtk-3-0'] } } },
      }),
      build({ formats: ['deb'] }),
    );
    expect(config.deb.depends).toEqual(['libgtk-3-0']);
  });

  test('a copyright and category reach the output when set', () => {
    const config = toPackagerConfig(
      desktopConfig({
        bundle: { copyright: '© 2026 Me', category: 'DeveloperTool' },
      }),
      build(),
    );
    expect(config.copyright).toBe('© 2026 Me');
    expect(config.category).toBe('DeveloperTool');
  });

  // D6: signing material comes from the environment, so no value of it may
  // appear in the generated config, whatever the caller's environment holds.
  test('no signing material appears in the output', () => {
    const saved = new Map();
    for (const name of SIGNING_ENVIRONMENT) {
      saved.set(name, process.env[name]);
      process.env[name] = `SECRET-${name}`;
    }
    try {
      const text = JSON.stringify(
        toPackagerConfig(
          desktopConfig(),
          build({ libraries: ['/b/lib.dylib'] }),
        ),
      );
      for (const name of SIGNING_ENVIRONMENT) {
        expect(text).not.toContain(`SECRET-${name}`);
      }
      // Nor may the variable names themselves appear: a config naming a
      // credential is a config someone will fill in.
      for (const name of SIGNING_ENVIRONMENT) {
        expect(text).not.toContain(name);
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('paths use forward slashes on every platform', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-slash-'));
    roots.push(root);
    const crateDir = path.join(root, 'desktop');
    fs.mkdirSync(path.join(crateDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(crateDir, 'build', 'index.bundle'), 'x');
    const config = toPackagerConfig(
      desktopConfig(),
      build({ crateDir, bundleDir: path.join(crateDir, 'build') }),
    );
    for (const entry of [
      ...config.resources,
      ...config.binaries.map(binary => binary.path),
    ]) {
      expect(entry).not.toContain('\\');
    }
  });
});

describe('targetProfileDir', () => {
  test('CARGO_TARGET_DIR wins over everything', () => {
    // CI sets it so the Cargo cache survives a deleted app directory; a config
    // that ignored it looked for the binary in a tree that does not exist.
    const root = createProject();
    const saved = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = '/ci/target';
    try {
      expect(targetProfileDir(path.join(root, 'desktop'), 'release')).toBe(
        path.join('/ci/target', 'release'),
      );
    } finally {
      if (saved === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = saved;
    }
  });

  test('a crate with no cargo config uses target/<profile>', () => {
    const root = createProject();
    expect(targetProfileDir(path.join(root, 'desktop'), 'release')).toBe(
      path.join(root, 'desktop', 'target', 'release'),
    );
  });

  test("the crate's target-dir setting wins", () => {
    // The scaffold redirects `target-dir` to `build/target` so build output does
    // not sit beside the sources; `target/release` then does not exist at all.
    const root = createProject({
      files: {
        'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
      },
    });
    expect(targetProfileDir(path.join(root, 'desktop'), 'release')).toBe(
      path.join(root, 'desktop', 'build', 'target', 'release'),
    );
  });

  test("the crate's target-dir may climb to a shared root target", () => {
    // The tester desktop shares the repository's one `target/` by climbing out
    // of its crate; resolving that from the crate is what finds the binary.
    const root = createProject({
      files: {
        'desktop/.cargo/config.toml':
          '[build]\ntarget-dir = "../../../target"\n',
      },
    });
    expect(targetProfileDir(path.join(root, 'desktop'), 'release')).toBe(
      path.resolve(root, 'desktop', '../../../target', 'release'),
    );
  });
});

// The Linux failure this covers was invisible from macOS for a whole round: an
// ELF `NEEDED` entry is a bare soname, so it must be resolved by searching the
// build, while a Mach-O dependency names its own path.
describe('parseSharedLibraryReferences', () => {
  const readelf = `
 0x0000000000000001 (NEEDED)             Shared library: [libjsi.so]
 0x0000000000000001 (NEEDED)             Shared library: [libhermesvm.so]
 0x0000000000000001 (NEEDED)             Shared library: [libgtk-3.so.0]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN/../lib/my-app]
`;

  test('ELF NEEDED entries come back as bare sonames', () => {
    expect(parseSharedLibraryReferences(readelf, 'linux')).toEqual([
      'libjsi.so',
      'libhermesvm.so',
      'libgtk-3.so.0',
    ]);
  });

  test('a RUNPATH line is not mistaken for a library', () => {
    expect(
      parseSharedLibraryReferences(readelf, 'linux').some(reference =>
        reference.includes('ORIGIN'),
      ),
    ).toBe(false);
  });

  test("otool's first line is the binary itself, not a dependency", () => {
    const otool = [
      '/build/app/Contents/MacOS/app:',
      '\t@rpath/libjsi.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)',
    ].join('\n');
    expect(parseSharedLibraryReferences(otool, 'darwin')).toEqual([
      '@rpath/libjsi.dylib',
      '/usr/lib/libSystem.B.dylib',
    ]);
  });

  test('a repeated dependency is listed once', () => {
    const repeated = `${readelf}\n 0x0 (NEEDED)  Shared library: [libjsi.so]`;
    expect(
      parseSharedLibraryReferences(repeated, 'linux').filter(
        reference => reference === 'libjsi.so',
      ),
    ).toHaveLength(1);
  });
});

test('a bare soname is found in the CMake tree, and a system library is not', () => {
  // The resolver cannot shell out to readelf on macOS, so the lookup it performs
  // for a bare ELF name is tested directly. The layout is the scaffolded one:
  // `.cargo/config.toml` redirects target-dir to `build/target`, and the C++
  // runtime's libraries are under `rn-gpui-cmake/<triple>/<config>/...`.
  const libjsi =
    'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release/build/ReactCommon/jsi/libjsi.so';
  const root = createProject({
    files: {
      'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
      'desktop/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
      [libjsi]: 'x',
    },
  });
  expect(resolveLinkedLibraryForTest('libjsi.so', root)).toBe(
    path.join(root, libjsi),
  );
  // A library the OS provides must not be shipped.
  expect(resolveLinkedLibraryForTest('libgtk-3.so.0', root)).toBeUndefined();
});

describe('recordedLibraryDirectories', () => {
  test('the directories CMake recorded are read back', () => {
    // The build writes `rpath_dirs-<Config>.txt` while configuring, and that list
    // becomes the executable's rpath. It is the only source that names the
    // prebuilt runtime's cache, which is not under the build tree at all.
    const root = createProject({
      files: {
        'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
        'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release/build/rpath_dirs-Release.txt':
          '/opt/prebuilt/0.0.3/linux-x64/lib\n/opt/hermes/bin/linux-x64\n',
      },
    });
    expect(recordedLibraryDirectories(root)).toEqual([
      '/opt/prebuilt/0.0.3/linux-x64/lib',
      '/opt/hermes/bin/linux-x64',
    ]);
  });

  test('a project with no build yet records nothing', () => {
    expect(recordedLibraryDirectories(createProject())).toEqual([]);
  });
});

test('a prebuilt-only library is found through the recorded directories', () => {
  // The case that failed on Linux: the app uses the prebuilt runtime, so
  // `libjsi.so` exists only in the prebuilt cache, outside both the project and
  // the build tree. The recorded rpath list is what makes it findable.
  const root = createProject({
    files: {
      'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
      'desktop/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
    },
  });
  const cache = path.join(root, 'prebuilt-cache', 'linux-x64', 'lib');
  fs.mkdirSync(cache, { recursive: true });
  const library = path.join(cache, 'libjsi.so');
  fs.writeFileSync(library, 'x');
  write(
    root,
    'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release/build/rpath_dirs-Release.txt',
    `${cache}\n`,
  );
  expect(resolveLinkedLibraryForTest('libjsi.so', root)).toBe(library);
});

describe('a package only ships libraries from its own release build', () => {
  // A clean runner has one config, so this cannot show up on CI. A developer's
  // tree accumulates Debug, Release and both -prebuilt variants; the first match
  // used to win and Debug sorts first, so a release package could pick up a Debug
  // library, or one built against the other runtime.
  function projectWithBothConfigs() {
    const root = createProject({
      files: {
        'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
        'desktop/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
        // A Debug library, and a Release one, at the same relative depth.
        'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Debug/build/ReactCommon/jsi/libjsi.so':
          'debug',
        'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release/build/ReactCommon/jsi/libjsi.so':
          'release',
      },
    });
    return root;
  }

  test('the Debug copy is not found', () => {
    const root = projectWithBothConfigs();
    const found = resolveLinkedLibraryForTest('libjsi.so', root);
    expect(found).toBeDefined();
    expect(found).toContain('Release');
    expect(found).not.toContain('Debug');
  });

  test('every directory offered to the resolver is a release config', () => {
    const root = projectWithBothConfigs();
    for (const directory of releaseLibraryDirectories(root)) {
      expect(directory).not.toMatch(/[/\\]Debug/u);
    }
  });

  test('Release-prebuilt outranks Release', () => {
    const root = createProject({
      files: {
        'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
        'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release/build/rpath_dirs-Release.txt':
          '/from/release\n',
        'desktop/build/target/rn-gpui-cmake/x86_64-unknown-linux-gnu/Release-prebuilt/build/rpath_dirs-Release.txt':
          '/from/release-prebuilt\n',
      },
    });
    expect(recordedLibraryDirectories(root)[0]).toBe('/from/release-prebuilt');
  });
});

test('a library reached by two paths is shipped once', () => {
  // The prebuilt cache and the CMake tree can both hold the same engine library.
  // The packaging configs map each entry to a destination by file name, so a
  // second entry would target the same file twice.
  const root = createProject({
    files: {
      'desktop/.cargo/config.toml': '[build]\ntarget-dir = "build/target"\n',
      'desktop/Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
      'desktop/target/release/libfoo.dylib': 'x',
      'desktop/build/target/release/libfoo.dylib': 'x',
    },
  });
  const names = runtimeLibraries(root, { os: 'darwin', arch: 'arm64' }).map(
    file => path.basename(file),
  );
  expect(names.filter(name => name === 'libfoo.dylib')).toHaveLength(1);
});
