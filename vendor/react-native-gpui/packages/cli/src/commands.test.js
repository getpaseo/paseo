import fs from 'node:fs';
import http from 'node:http';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import {
  collectNodeAddons,
  createLibrary,
  desktopLaunchConfig,
  linuxBuildDependencyProblem,
  metroProjectRoot,
  metroTerminal,
  scanNodeAddonCalls,
  scaffoldDesktop,
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
      libraryName: 'fs',
      type: 'rust',
      destination: outer,
      packageName: '@react-native-gpui/fs',
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
