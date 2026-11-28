import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import {
  runBundleHooks,
  assertReleaseExists,
  collectNodeAddons,
  copyDebugSymbols,
  gpuiVersionRange,
  reactNativeMinor,
  createLibrary,
  desktopLaunchConfig,
  isTransientPackagerFailure,
  linuxBuildDependencyProblem,
  metroProjectRoot,
  metroTerminal,
  runPackager,
  scanNodeAddonCalls,
  scaffoldDesktop,
  signCollectedNodeAddons,
  stageBundle,
} from './commands.js';

// The repository root by lookup, not by counting parents: this file sits at a
// different depth before and after a folder move.
const repoRoot = (() => {
  let dir = nodePath.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = nodePath.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces)
          return dir;
      } catch {}
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) throw new Error('no workspace root above the test');
    dir = parent;
  }
})();
const temporaryRoots = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Linux preflight accepts a complete system', () => {
  expect(linuxBuildDependencyProblem('linux', () => true)).toBeNull();
});

test('the Linux preflight names the missing module and its package', () => {
  const problem = linuxBuildDependencyProblem('linux', pc => pc !== 'xcb');
  expect(problem).toContain('dependency xcb was not found');
  expect(problem).toContain('libxcb1-dev');
  expect(problem).toContain('PKG_CONFIG_PATH');
});

test('the Linux preflight gives one package name per distribution', () => {
  const problem = linuxBuildDependencyProblem(
    'linux',
    pc => pc !== 'xkbcommon',
  );
  expect(problem).toContain('Debian/Ubuntu: sudo apt install libxkbcommon-dev');
  expect(problem).toContain('Fedora: sudo dnf install libxkbcommon-devel');
  expect(problem).toContain('Arch: sudo pacman -S libxkbcommon');
});

test('the Linux preflight prints the computed system pkg-config path', () => {
  const path = '/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig';
  const problem = linuxBuildDependencyProblem(
    'linux',
    () => false,
    () => path,
  );
  expect(problem).toContain(`PKG_CONFIG_PATH=${path}`);
});

test('the Linux preflight falls back when the system path is unknown', () => {
  const problem = linuxBuildDependencyProblem(
    'linux',
    () => false,
    () => null,
  );
  expect(problem).not.toContain('PKG_CONFIG_PATH=');
  expect(problem).toContain('point PKG_CONFIG_PATH at your system pkgconfig');
});

test('the Linux preflight reports a missing pkg-config', () => {
  expect(
    linuxBuildDependencyProblem('linux', () => 'missing-pkg-config'),
  ).toContain('pkg-config is required');
});

test('the Linux preflight is a no-op on other platforms', () => {
  expect(linuxBuildDependencyProblem('darwin', () => false)).toBeNull();
  expect(linuxBuildDependencyProblem('win32', () => false)).toBeNull();
});

// --- collect-node-addons -----------------------------------------------------

test('the scanner reads every key/path pair a bundle emits', () => {
  const bundle = [
    'var a = _requireNodeLibrary("node_modules/pkg/prebuilds/x.node", "/app/node_modules/pkg/prebuilds/x.node");',
    'var b = _requireNodeLibrary(\n  "local/deadbeef/y.node",\n  "/app/build/Release/y.node"\n);',
  ].join('\n');
  expect(scanNodeAddonCalls(bundle)).toEqual([
    {
      key: 'node_modules/pkg/prebuilds/x.node',
      path: '/app/node_modules/pkg/prebuilds/x.node',
    },
    { key: 'local/deadbeef/y.node', path: '/app/build/Release/y.node' },
  ]);
});

test('the scanner reports one entry per key', () => {
  const bundle =
    '_requireNodeLibrary("a/x.node","/p/x.node");_requireNodeLibrary("a/x.node","/p/x.node");';
  expect(scanNodeAddonCalls(bundle)).toHaveLength(1);
});

test('the scanner ignores a call with only a key', () => {
  expect(scanNodeAddonCalls('_requireNodeLibrary("a/x.node")')).toEqual([]);
});

test('the scanner unescapes the path Babel emitted', () => {
  const bundle = String.raw`_requireNodeLibrary("local/1/a.node","C:\\app\\a.node");`;
  expect(scanNodeAddonCalls(bundle)[0].path).toBe('C:\\app\\a.node');
});

test('collect-node-addons copies each addon to <out>/<key>', () => {
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local/collect-'));
  temporaryRoots.push(root);
  const addonPath = nodePath.join(root, 'build/Release/addon.node');
  fs.mkdirSync(nodePath.dirname(addonPath), { recursive: true });
  fs.writeFileSync(addonPath, 'binary');
  const bundlePath = nodePath.join(root, 'bundle.js');
  // The Babel plugin emits the path through `t.stringLiteral`, so it is escaped
  // as a JS string literal would be — backslashes and all on Windows.
  fs.writeFileSync(
    bundlePath,
    `_requireNodeLibrary("local/1/addon.node",${JSON.stringify(addonPath)});`,
  );
  const out = nodePath.join(root, 'node-addons');
  const result = collectNodeAddons({ bundle: bundlePath, out });
  expect(result.copied).toHaveLength(1);
  expect(
    fs.readFileSync(nodePath.join(out, 'local/1/addon.node'), 'utf8'),
  ).toBe('binary');
});

test('collect-node-addons copies sibling shared libraries', () => {
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local/collect-'));
  temporaryRoots.push(root);
  const directory = nodePath.join(root, 'build/Release');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(nodePath.join(directory, 'addon.node'), 'binary');
  fs.writeFileSync(nodePath.join(directory, 'libdep.so'), 'shared');
  fs.writeFileSync(nodePath.join(directory, 'libdep.so.1'), 'shared');
  fs.writeFileSync(nodePath.join(directory, 'unrelated.txt'), 'no');
  const bundlePath = nodePath.join(root, 'bundle.js');
  fs.writeFileSync(
    bundlePath,
    `_requireNodeLibrary("local/1/addon.node",${JSON.stringify(nodePath.join(directory, 'addon.node'))});`,
  );
  const out = nodePath.join(root, 'node-addons');
  collectNodeAddons({ bundle: bundlePath, out, platform: 'linux' });
  expect(fs.existsSync(nodePath.join(out, 'local/1/libdep.so'))).toBe(true);
  expect(fs.existsSync(nodePath.join(out, 'local/1/libdep.so.1'))).toBe(true);
  expect(fs.existsSync(nodePath.join(out, 'local/1/unrelated.txt'))).toBe(
    false,
  );
});

test('collect-node-addons fails when an embedded path is gone', () => {
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local/collect-'));
  temporaryRoots.push(root);
  const bundlePath = nodePath.join(root, 'bundle.js');
  fs.writeFileSync(
    bundlePath,
    '_requireNodeLibrary("local/1/gone.node","/nowhere/gone.node");',
  );
  expect(() =>
    collectNodeAddons({ bundle: bundlePath, out: nodePath.join(root, 'out') }),
  ).toThrow(/no longer exist/u);
});

test('collect-node-addons clears a stale directory when the bundle has none', () => {
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local/collect-'));
  temporaryRoots.push(root);
  const bundlePath = nodePath.join(root, 'bundle.js');
  fs.writeFileSync(bundlePath, 'var x = 1;');
  const out = nodePath.join(root, 'node-addons');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(nodePath.join(out, 'stale'), 'x');
  const result = collectNodeAddons({ bundle: bundlePath, out });
  expect(result.copied).toEqual([]);
  expect(fs.existsSync(out)).toBe(false);
});

test('collect-node-addons requires both arguments', () => {
  expect(() => collectNodeAddons({})).toThrow(/--bundle/u);
  expect(() => collectNodeAddons({ bundle: 'x' })).toThrow(/--out/u);
});

// The launch chain used to be built from `app.json`'s `desktop` key. It reads
// `desktop/desktop.json` now, and these check that the generated `main.rs` is
// the same for the same options.
test('urlSchemes reach the launch chain and turn single instance on', () => {
  const chain = desktopLaunchConfig(
    { devMenu: true, urlSchemes: ['myapp', 'my-app'], singleInstance: true },
    'desktop/desktop.json',
  );
  expect(chain).toContain('.url_schemes(&["myapp", "my-app"])');
  expect(chain).toContain('.single_instance(true)');
  const none = desktopLaunchConfig(
    { devMenu: true, urlSchemes: [], singleInstance: false },
    'desktop/desktop.json',
  );
  expect(none).not.toContain('.url_schemes(');
});

test('menuBar: false asks the host for no menu bar, and its absence does not', () => {
  const hidden = desktopLaunchConfig(
    { window: { menuBar: false }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(hidden).toContain('.menu_bar(false)');

  // The default is a menu bar, so the call is only emitted when it is turned off:
  // a chain that always emitted it would be the same thing, but the generated file
  // reads better without a line saying what the default already is.
  const shown = desktopLaunchConfig(
    { window: { menuBar: true }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(shown).not.toContain('.menu_bar(');
});

test('windowControlsPosition: left reaches the launch chain, and right does not', () => {
  const left = desktopLaunchConfig(
    { window: { windowControlsPosition: 'left' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(left).toContain('.window_controls_position("left")');
  const right = desktopLaunchConfig(
    { window: { windowControlsPosition: 'right' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(right).not.toContain('.window_controls_position(');
});

test('a custom title bar and the traffic light position reach the launch chain', () => {
  const hidden = desktopLaunchConfig(
    {
      window: {
        titleBar: 'hidden',
        trafficLightPosition: { x: 14, y: 10 },
      },
      devMenu: true,
    },
    'desktop/desktop.json',
  );
  expect(hidden).toContain(
    '.title_bar(react_native_gpui::WindowTitleBar::Hidden)',
  );
  expect(hidden).toContain('.traffic_light_position(14.0, 10.0)');

  const transparent = desktopLaunchConfig(
    { window: { titleBar: 'transparent' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(transparent).toContain(
    '.title_bar(react_native_gpui::WindowTitleBar::Transparent)',
  );

  // `default` is what an app that says nothing already gets, so it must not add
  // a call that only restates it.
  const plain = desktopLaunchConfig(
    { window: { titleBar: 'default' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(plain).not.toContain('.title_bar(');
  expect(plain).not.toContain('.traffic_light_position(');
});

test('a window background reaches the launch chain, and opaque adds nothing', () => {
  const blurred = desktopLaunchConfig(
    { window: { background: 'blurred' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(blurred).toContain(
    '.background(react_native_gpui::WindowBackground::Blurred)',
  );
  const opaque = desktopLaunchConfig(
    { window: { background: 'opaque' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(opaque).not.toContain('.background(');
  expect(() =>
    desktopLaunchConfig(
      { window: { background: 'glass' }, devMenu: true },
      'desktop/desktop.json',
    ),
  ).toThrow(/window.background must be/u);
});

test('an accessory app reaches the launch chain, and a regular one adds nothing', () => {
  expect(
    desktopLaunchConfig(
      { accessory: true, devMenu: true },
      'desktop/desktop.json',
    ),
  ).toContain('.accessory(true)');
  expect(
    desktopLaunchConfig({ devMenu: true }, 'desktop/desktop.json'),
  ).not.toContain('.accessory(');
});

test('hiding the window buttons and the shadow reaches the launch chain', () => {
  const bare = desktopLaunchConfig(
    { window: { windowButtons: false, shadow: false }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(bare).toContain('.window_buttons(false)');
  expect(bare).toContain('.shadow(false)');
  const plain = desktopLaunchConfig(
    { window: { windowButtons: true, shadow: true }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(plain).not.toContain('.window_buttons(');
  expect(plain).not.toContain('.shadow(');
});

test('a traffic light position without both coordinates is rejected', () => {
  // The schema says `x` and `y` are both required; a launcher that silently used
  // the origin would move the traffic lights to the corner of the window.
  expect(() =>
    desktopLaunchConfig(
      { window: { trafficLightPosition: { x: 14 } }, devMenu: true },
      'desktop/desktop.json',
    ),
  ).toThrow(/trafficLightPosition needs x and y/u);
});

test('the launch chain reflects the window, dev menu and tray', () => {
  const main = desktopLaunchConfig(
    {
      window: { width: 900, height: 700, title: 'My App', resizable: true },
      devMenu: true,
      tray: { component: 'TrayRoot', tooltip: 'Open', accessory: true },
    },
    'desktop/desktop.json',
  );
  expect(main).toContain('.window_title("My App")');
  expect(main).toContain('.window_size(900.0, 700.0)');
  expect(main).toContain('.dev_menu(true)');
  expect(main).toContain(
    '.tray(TrayConfig::default().component("TrayRoot").tooltip("Open"))',
  );
  expect(main).toContain('options.is_resizable = true;');
});

test('an app asking to restore nothing and be fixed-size says so', () => {
  const main = desktopLaunchConfig(
    {
      window: {
        width: 400,
        height: 300,
        resizable: false,
        restoreState: false,
        position: { x: 10, y: 20 },
      },
      devMenu: false,
    },
    'desktop/desktop.json',
  );
  expect(main).toContain('.restore_window_state(false)');
  expect(main).toContain('.window_position(10.0, 20.0)');
  expect(main).toContain('.dev_menu(false)');
  expect(main).toContain('options.is_resizable = false;');
  expect(main).not.toContain('.tray(');
});

test('a tray with accessory false disables the accessory mode', () => {
  const main = desktopLaunchConfig(
    {
      window: { width: 1, height: 1 },
      devMenu: true,
      tray: { accessory: false },
    },
    'desktop/desktop.json',
  );
  expect(main).toContain('.tray(TrayConfig::default().accessory(false))');
});

test('create-library writes version requirements, not crate paths', () => {
  // A module crate installed from npm has no `../../../packages` above it, so a
  // relative path to core cannot work there; `[patch.crates-io]` also cannot
  // redirect a `path` dependency. The scaffolder therefore writes a version
  // requirement and lets autolink patch it to the installed core.
  const outer = fs.mkdtempSync(nodePath.join(repoRoot, '.local', 'scaffold-'));
  try {
    createLibrary({
      libraryName: 'example',
      type: 'rust',
      destination: outer,
      packageName: '@react-native-gpui/example',
    });
    const manifest = fs.readFileSync(
      nodePath.join(outer, 'desktop/Cargo.toml'),
      'utf8',
    );
    expect(manifest).toContain('rn-gpui-module = "0.1"');
    expect(manifest).toContain('rn-gpui-module-build = "0.1"');
    expect(manifest).not.toMatch(/path\s*=/u);
    expect(manifest).not.toMatch(/git\s*=/u);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('scaffoldDesktop writes the env file that exposes the desktop types', () => {
  // The augmentation is global, and a TypeScript augmentation only applies when
  // its declaring file is compiled. This reference is what puts it in the app's
  // compilation, so `desktopDragRegion` and `onContextMenu` type-check without an
  // import of the desktop entry point.
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local', 'envtypes-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'package.json'),
      `${JSON.stringify({ name: 'envapp', dependencies: { 'react-native': '0.87.1' } })}\n`,
    );
    fs.writeFileSync(
      nodePath.join(root, 'app.json'),
      `${JSON.stringify({ name: 'EnvApp', displayName: 'EnvApp' })}\n`,
    );
    scaffoldDesktop(
      root,
      JSON.parse(fs.readFileSync(nodePath.join(root, 'package.json'), 'utf8')),
    );

    const envPath = nodePath.join(root, 'react-native-gpui-env.d.ts');
    const written = fs.readFileSync(envPath, 'utf8');
    expect(written).toContain(
      '/// <reference types="@react-native-gpui/core/types" />',
    );
    expect(written).toContain('Do not edit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scaffoldDesktop keeps an app’s edited env file', () => {
  // `preserveExisting` is how `init-desktop` runs on an app that already has a
  // desktop folder, so an app that added its own references there must keep them.
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.local', 'envkeep-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'package.json'),
      `${JSON.stringify({ name: 'keepapp', dependencies: { 'react-native': '0.87.1' } })}\n`,
    );
    fs.writeFileSync(
      nodePath.join(root, 'app.json'),
      `${JSON.stringify({ name: 'KeepApp', displayName: 'KeepApp' })}\n`,
    );
    const envPath = nodePath.join(root, 'react-native-gpui-env.d.ts');
    const edited = '/// <reference types="custom" />\n';
    fs.writeFileSync(envPath, edited);

    scaffoldDesktop(
      root,
      JSON.parse(fs.readFileSync(nodePath.join(root, 'package.json'), 'utf8')),
      { preserveExisting: true },
    );
    expect(fs.readFileSync(envPath, 'utf8')).toBe(edited);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Metro opens in the requested terminal, then the platform default', () => {
  const none = () => false;
  expect(metroTerminal('Warp', { platform: 'darwin', env: {} })).toBe('Warp');
  expect(
    metroTerminal(undefined, {
      platform: 'darwin',
      env: { REACT_TERMINAL: 'Ghostty' },
    }),
  ).toBe('Ghostty');
  expect(
    metroTerminal(undefined, {
      platform: 'darwin',
      env: { TERM_PROGRAM: 'vscode' },
    }),
  ).toBe('Terminal');
  expect(
    metroTerminal(undefined, {
      platform: 'darwin',
      env: { TERM_PROGRAM: 'iTerm.app' },
    }),
  ).toBe('iTerm');
  expect(metroTerminal(undefined, { platform: 'win32', env: {} })).toBe(
    'cmd.exe',
  );
  expect(
    metroTerminal(undefined, {
      platform: 'linux',
      env: {},
      exists: command => command === 'konsole',
    }),
  ).toBe('konsole');
  expect(
    metroTerminal(undefined, { platform: 'linux', env: {}, exists: none }),
  ).toBeUndefined();
});

test('a running Metro reports the project it serves', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('X-React-Native-Project-Root', '/some/project');
    response.end(
      request.url === '/status' ? 'packager-status:running' : 'not found',
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    expect(await metroProjectRoot('127.0.0.1', port)).toBe('/some/project');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  expect(await metroProjectRoot('127.0.0.1', port)).toBeUndefined();
});

test('a tray icon in desktop.json is embedded in the launch chain', () => {
  const chain = desktopLaunchConfig(
    {
      tray: { tooltip: 'Tray', icon: 'assets/tray.png', iconTemplate: true },
      devMenu: true,
    },
    'desktop/desktop.json',
  );
  expect(chain).toContain(
    '.icon_bytes(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/tray.png")))',
  );
  expect(chain).toContain('.icon_template(true)');
  expect(
    desktopLaunchConfig({ tray: { tooltip: 'Tray' }, devMenu: true }, 'x'),
  ).not.toContain('.icon_bytes(');
});

function stageFixture(content) {
  const projectRoot = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'stage-bundle-'),
  );
  temporaryRoots.push(projectRoot);
  const runtimeBundlePath = nodePath.join(projectRoot, 'compiled.bundle');
  fs.writeFileSync(runtimeBundlePath, content);
  return { projectRoot, build: { runtimeBundlePath } };
}

test('stageBundle accepts the bytecode magic the engine declares', () => {
  const magic = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const staged = stageBundle({
    ...stageFixture(Buffer.concat([magic, Buffer.from('rest')])),
    engine: { compile() {}, bytecodeMagic: magic },
    engineName: 'other',
  });
  expect(fs.existsSync(staged)).toBe(true);
});

test('stageBundle names the engine when its output lacks the declared magic', () => {
  expect(() =>
    stageBundle({
      ...stageFixture('console.log(1)'),
      engine: { compile() {}, bytecodeMagic: Buffer.from([1, 2, 3, 4]) },
      engineName: 'other',
    }),
  ).toThrow(/the other engine did not produce bytecode/u);
});

test('stageBundle trusts an engine that compiles but declares no magic', () => {
  const staged = stageBundle({
    ...stageFixture('opaque'),
    engine: { compile() {} },
    engineName: 'other',
  });
  expect(fs.readFileSync(staged, 'utf8')).toBe('opaque');
});

test('stageBundle ships JavaScript for an engine without a compiler', () => {
  const staged = stageBundle({
    ...stageFixture('console.log(1)'),
    engine: {},
    engineName: 'plain',
  });
  expect(fs.readFileSync(staged, 'utf8')).toBe('console.log(1)');
});

test('the React Native minor comes from an exact version or a range', () => {
  expect(reactNativeMinor('0.87.1')).toBe(87);
  expect(reactNativeMinor('^0.88.0')).toBe(88);
  expect(reactNativeMinor('~0.87.2')).toBe(87);
  expect(reactNativeMinor('latest')).toBeUndefined();
  expect(reactNativeMinor(undefined)).toBeUndefined();
});

test("our packages are asked for at the app's React Native minor", () => {
  expect(
    gpuiVersionRange('/nowhere', {
      dependencies: { 'react-native': '0.87.1' },
    }),
  ).toBe('~0.87.0-alpha.0');
  expect(() => gpuiVersionRange('/nowhere', { dependencies: {} })).toThrow(
    /Cannot tell which React Native version/,
  );
});

test('scaffolding writes the matching range for every package it adds', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rn-gpui-scaffold-'));
  try {
    fs.writeFileSync(nodePath.join(root, 'app.json'), '{"name":"App"}');
    const result = scaffoldDesktop(root, {
      name: 'app',
      dependencies: { 'react-native': '0.87.1' },
    });
    expect(result.dependencies['@react-native-gpui/core']).toBe(
      '~0.87.0-alpha.0',
    );
    expect(result.dependencies['@react-native-gpui/hermes']).toBe(
      '~0.87.0-alpha.0',
    );
    expect(result.devDependencies['@react-native-gpui/cli']).toBe(
      '~0.87.0-alpha.0',
    );
    expect(result.scripts.desktop).toBe('react-native run-desktop');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scaffolding adds the desktop module of a library the app uses', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rn-gpui-scaffold-'));
  try {
    fs.writeFileSync(nodePath.join(root, 'app.json'), '{"name":"App"}');
    const result = scaffoldDesktop(root, {
      name: 'app',
      dependencies: {
        'react-native': '0.87.1',
        'react-native-safe-area-context': '^5.5.2',
      },
    });
    expect(result.dependencies['react-native-safe-area-context']).toBe(
      '~5.10.0',
    );
    expect(result.dependencies['@react-native-gpui/safe-area-context']).toBe(
      '~5.10.0-alpha.0',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a React Native minor without a release is refused with a clear message', () => {
  const view = result => () => result;
  expect(() =>
    assertReleaseExists('~0.88.0-alpha.0', {
      registryView: view({ status: 0, stdout: '' }),
    }),
  ).toThrow(/supports React Native 0\.88/);
  expect(() =>
    assertReleaseExists('~0.87.0-alpha.0', {
      registryView: view({ status: 0, stdout: '"0.87.0-alpha.0"' }),
    }),
  ).not.toThrow();
  expect(() =>
    assertReleaseExists('~0.87.0-alpha.0', {
      registryView: view({ status: 1, stderr: 'npm error code E404' }),
    }),
  ).toThrow(/not published/);
  expect(() =>
    assertReleaseExists('~0.87.0-alpha.0', {
      registryView: view({ status: 1, stderr: 'ENOTFOUND' }),
    }),
  ).not.toThrow();
});

test('the tray popover position reaches the launch chain', () => {
  const placed = desktopLaunchConfig(
    {
      tray: {
        component: 'Panel',
        popoverAnchor: 'top-left',
        popoverOffset: { x: 4, y: -2 },
      },
      devMenu: true,
    },
    'desktop/desktop.json',
  );
  expect(placed).toContain('.popover_anchor_name("top-left")');
  expect(placed).toContain('.popover_offset(4.0, -2.0)');

  // 'auto' is the default, so no call is emitted for it.
  const auto = desktopLaunchConfig(
    { tray: { component: 'Panel', popoverAnchor: 'auto' }, devMenu: true },
    'desktop/desktop.json',
  );
  expect(auto).not.toContain('popover_anchor_name');
});

test('a busy disk image and a failed download are told from a real failure', () => {
  expect(
    isTransientPackagerFailure(
      'stderr: hdiutil: create failed - Resource busy',
    ),
  ).toBe(true);
  expect(
    isTransientPackagerFailure(
      'ERROR https://github.com/x/NSIS.zip: status code 504',
    ),
  ).toBe(true);
  expect(isTransientPackagerFailure('error: connection timed out')).toBe(true);
  expect(
    isTransientPackagerFailure('ERROR https://x/y.zip: status code 404'),
  ).toBe(false);
  expect(isTransientPackagerFailure('error[E0425]: cannot find value')).toBe(
    false,
  );
});

test.skipIf(process.platform === 'win32')(
  'cargo-packager is run again when it fails in a passing way',
  async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'packager-'));
    const counter = nodePath.join(dir, 'runs');
    const cargo = nodePath.join(dir, 'cargo');
    fs.writeFileSync(
      cargo,
      `#!/bin/sh\necho x >> "${counter}"\nif [ "$(wc -l < "${counter}")" -lt 3 ]; then echo 'ERROR https://x/NSIS.zip: status code 504' >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${dir}${nodePath.delimiter}${path}`;
    const waits = [];
    try {
      await runPackager(['packager'], {
        cwd: dir,
        wait: ms => waits.push(ms),
      });
      expect(waits).toEqual([5000, 10000]);
      expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(
        3,
      );
      fs.rmSync(counter);
      await expect(
        runPackager(['packager'], { cwd: dir, attempts: 2, wait: () => {} }),
      ).rejects.toThrow(/Command failed/u);
    } finally {
      process.env.PATH = path;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('runs the bundle hook of each autolinked package and collects what it ships', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bundle-hook-'));
  try {
    const hook = nodePath.join(root, 'hook.cjs');
    fs.writeFileSync(
      hook,
      "module.exports = async context => [require('node:path').join(context.bundleDir, 'workers')];\n",
    );
    fs.mkdirSync(nodePath.join(root, 'desktop', 'autolink'), {
      recursive: true,
    });
    fs.writeFileSync(
      nodePath.join(root, 'desktop', 'autolink', 'autolink.json'),
      JSON.stringify({ bundleHooks: [{ dependencyName: 'x', module: hook }] }),
    );
    const resources = await runBundleHooks({
      projectRoot: root,
      desktopRoot: nodePath.join(root, 'desktop'),
      bundleDir: nodePath.join(root, 'desktop', 'build'),
    });
    expect(resources).toEqual([
      nodePath.join(root, 'desktop', 'build', 'workers'),
    ]);
    expect(
      await runBundleHooks({
        projectRoot: root,
        desktopRoot: nodePath.join(root, 'nothing'),
        bundleDir: root,
      }),
    ).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collected addons and their libraries are signed with the given identity on macOS only', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rn-gpui-sign-'));
  temporaryRoots.push(root);
  const lib = nodePath.join(root, 'node_modules', 'pkg', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(nodePath.join(lib, 'a.node'), '');
  fs.writeFileSync(nodePath.join(lib, 'libb.dylib'), '');
  fs.writeFileSync(nodePath.join(lib, 'readme.txt'), '');
  const calls = [];
  const exec = (command, args) => calls.push([command, ...args]);
  signCollectedNodeAddons({
    directory: root,
    identity: 'ID',
    platform: 'darwin',
    exec,
  });
  expect(calls.map(call => call.slice(0, 4))).toEqual([
    ['codesign', '--force', '--sign', 'ID'],
    ['codesign', '--force', '--sign', 'ID'],
  ]);
  expect(calls.map(call => nodePath.basename(call[4])).sort()).toEqual([
    'a.node',
    'libb.dylib',
  ]);
  calls.length = 0;
  signCollectedNodeAddons({ directory: root, platform: 'darwin', exec });
  signCollectedNodeAddons({
    directory: root,
    identity: 'ID',
    platform: 'linux',
    exec,
  });
  expect(calls).toEqual([]);
});

test('packaging copies Cargo dSYM contents without retaining its build-tree symlink', () => {
  fs.mkdirSync(nodePath.join(repoRoot, '.artifacts'), { recursive: true });
  const root = fs.mkdtempSync(nodePath.join(repoRoot, '.artifacts/gpui-dsym-'));
  temporaryRoots.push(root);
  const crateDir = nodePath.join(root, 'desktop');
  const release = nodePath.join(crateDir, 'target/release');
  const symbols = nodePath.join(release, 'deps/app-hash.dSYM');
  const dwarf = 'Contents/Resources/DWARF/app';
  fs.mkdirSync(nodePath.dirname(nodePath.join(symbols, dwarf)), { recursive: true });
  fs.writeFileSync(nodePath.join(symbols, dwarf), 'debug symbols');
  const cargoLink = nodePath.join(release, 'app.dSYM');
  fs.symlinkSync('deps/app-hash.dSYM', cargoLink);
  const outDir = nodePath.join(root, 'dist');
  fs.mkdirSync(outDir);

  copyDebugSymbols({ crateDir, binaryName: 'app', outDir });

  expect(fs.lstatSync(cargoLink).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(nodePath.join(outDir, 'app.dSYM')).isSymbolicLink()).toBe(false);
  fs.rmSync(release, { recursive: true });
  expect(fs.readFileSync(nodePath.join(outDir, 'app.dSYM', dwarf), 'utf8')).toBe('debug symbols');
});
