import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import { afterAll, expect, test } from 'vitest';
import plugin, {
  addonKey,
  isHostPrebuiltNodeAddon,
  resolveAddon,
} from './babel-plugin-node-addons.js';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoots = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A scratch directory whose real path is stable for the test's duration. */
function scratch() {
  const root = fs.mkdtempSync(path.join(packageRoot, '.node-addons-test-'));
  temporaryRoots.push(root);
  // `mkdtempSync` under /var on macOS is a symlink farm; resolve it once so
  // expectations about the key match what the plugin sees.
  return fs.realpathSync(root);
}

function write(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function transform(source, { filename, platform = 'desktop', ...options }) {
  return transformSync(source, {
    filename,
    caller: { name: 'metro', bundler: 'metro', platform },
    configFile: false,
    babelrc: false,
    plugins: [[plugin, options]],
    compact: false,
  }).code;
}

/**
 * A file that passes the host guard on the host the test runs on. The guard
 * reads real bytes, so a valid header has to be written rather than a text
 * placeholder.
 */
function hostAddonHeader() {
  if (process.platform === 'linux') {
    const header = Buffer.alloc(20);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header, 0);
    header.writeUInt16LE(process.arch === 'arm64' ? 0xb7 : 0x3e, 18);
    return header;
  }
  if (process.platform === 'darwin') {
    // 64-bit thin little-endian Mach-O for the host CPU.
    const header = Buffer.alloc(32);
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(header, 0);
    header.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    return header;
  }
  if (process.platform === 'win32') {
    // A PE image for the host machine: `MZ`, the `PE\0\0` signature at the
    // offset named at 0x3C, and the machine field right after it.
    return peHeader(process.arch === 'arm64' ? 0xaa64 : 0x8664);
  }
  return Buffer.from('not a real binary');
}

/** A PE image header for one machine value. */
function peHeader(machine) {
  const header = Buffer.alloc(64);
  Buffer.from([0x4d, 0x5a]).copy(header, 0);
  header.writeUInt32LE(0x40, 0x3c);
  // The signature sits at 0x40, which is past the 64 bytes read here, so the
  // smallest valid file the plugin can accept is 0x46 bytes; write enough.
  const full = Buffer.alloc(0x48);
  header.copy(full, 0);
  Buffer.from([0x50, 0x45, 0x00, 0x00]).copy(full, 0x40);
  full.writeUInt16LE(machine, 0x44);
  return full;
}

/** A file the host guard rejects: an ELF for the other architecture. */
function foreignAddonHeader() {
  if (process.platform === 'darwin') {
    const header = Buffer.alloc(32);
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(header, 0);
    header.writeUInt32LE(process.arch === 'arm64' ? 0x01000007 : 0x0100000c, 4);
    return header;
  }
  if (process.platform === 'win32') {
    // The other Windows machine: a PE for the CPU the host is not.
    return peHeader(process.arch === 'arm64' ? 0x8664 : 0xaa64);
  }
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header, 0);
  header.writeUInt16LE(process.arch === 'arm64' ? 0x3e : 0xb7, 18);
  return header;
}

function writeAddon(filePath, header = hostAddonHeader()) {
  write(filePath, header);
}

/** An ELF header for one Linux e_machine value. */
function elfHeader(machine) {
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header, 0);
  header.writeUInt16LE(machine, 18);
  return header;
}

/** A 64-bit thin little-endian Mach-O header for one cputype value. */
function machoHeader(cputype) {
  const header = Buffer.alloc(32);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(header, 0);
  header.writeUInt32LE(cputype, 4);
  return header;
}

/**
 * Writes a binary for one named target, so a test can hand the plugin a host
 * other than the one it runs on and still get bytes that match.
 */
/** `writeAddonFor` under a shorter name for the R4 tag tests. */
function writeAddonAt(filePath, hostPlatform, hostArch) {
  writeAddonFor(filePath, hostPlatform, hostArch);
}

function writeAddonFor(filePath, hostPlatform, hostArch) {
  if (hostPlatform === 'linux') {
    writeAddon(filePath, elfHeader(hostArch === 'arm64' ? 0xb7 : 0x3e));
    return;
  }
  if (hostPlatform === 'darwin') {
    writeAddon(
      filePath,
      machoHeader(hostArch === 'arm64' ? 0x0100000c : 0x01000007),
    );
    return;
  }
  if (hostPlatform === 'win32') {
    writeAddon(filePath, peHeader(hostArch === 'arm64' ? 0xaa64 : 0x8664));
    return;
  }
  // Other platforms' binaries are not header-checked.
  writeAddon(filePath);
}

/**
 * The `_requireNodeLibrary(...)` arguments in transformed code. The plugin emits
 * paths through `t.stringLiteral`, so on Windows every backslash is escaped
 * (`"C:\\dir\\addon.node"`); each captured literal is decoded back to the real
 * string before it is compared.
 */
function callsIn(code) {
  const calls = [];
  const pattern =
    /_requireNodeLibrary\(\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"((?:[^"\\]|\\.)*)")?\s*\)/gu;
  const decode = value =>
    value === undefined ? undefined : JSON.parse(`"${value}"`);
  for (const match of code.matchAll(pattern)) {
    calls.push({ key: decode(match[1]), path: decode(match[2]) });
  }
  return calls;
}

test('rewrites a relative .node require on gpui', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/addon.node');
  writeAddon(addon);
  const code = transform(
    "const addon = require('./build/Release/addon.node');",
    {
      filename: path.join(root, 'index.js'),
    },
  );
  expect(code).toContain('_requireNodeLibrary');
  expect(code).not.toContain('require(');
  const [call] = callsIn(code);
  expect(call.key).toBe(`local/${addonKey(addon).split('/')[1]}/addon.node`);
  expect(call.path).toBe(addon);
});

test('leaves the require untouched on ios and android', () => {
  const root = scratch();
  writeAddon(path.join(root, 'addon.node'));
  const source = "const addon = require('./addon.node');";
  for (const platform of ['ios', 'android', 'web']) {
    const code = transform(source, {
      filename: path.join(root, 'index.js'),
      platform,
    });
    expect(code).toContain("require('./addon.node')");
    expect(code).not.toContain('_requireNodeLibrary');
  }
});

test('rewrites every import form', () => {
  const root = scratch();
  writeAddon(path.join(root, 'thing.node'));
  const filename = path.join(root, 'index.js');
  const cases = [
    [
      "import binding from './thing.node';",
      /const _nodeAddonExports = _requireNodeLibrary\(/u,
    ],
    [
      "import * as binding from './thing.node';",
      /const binding = _nodeAddonExports/u,
    ],
    [
      "import { add, sub as minus } from './thing.node';",
      /const \{\s+add: add,\s+sub: minus\s+\} = _nodeAddonExports/u,
    ],
    ["import './thing.node';", /^_requireNodeLibrary\(/mu],
  ];
  for (const [source, pattern] of cases) {
    const code = transform(source, { filename });
    expect(code, source).toMatch(pattern);
    expect(code, source).toContain('_requireNodeLibrary(');
  }
});

test('a bare .node specifier resolves through node resolution', () => {
  const root = scratch();
  const addon = path.join(
    root,
    'node_modules/some-package/prebuilds/thing.node',
  );
  write(filePathIn(root, 'node_modules/some-package/package.json'), '{}');
  writeAddon(addon);
  const code = transform("require('some-package/prebuilds/thing.node');", {
    filename: path.join(root, 'index.js'),
  });
  const [call] = callsIn(code);
  expect(call.path).toBe(addon);
  expect(call.key).toBe('node_modules/some-package/prebuilds/thing.node');
});

test('a missing .node file becomes a throwing expression with a code', () => {
  const root = scratch();
  const code = transform("require('./missing.node');", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain("Cannot find module './missing.node'");
  expect(code).toContain('MODULE_NOT_FOUND');
  expect(code).not.toContain('_requireNodeLibrary');
});

test('a surrounding try/catch catches the throwing expression', () => {
  const root = scratch();
  const code = transform(
    "let value; try { value = require('./missing.node'); } catch (error) { value = error.code; }",
    { filename: path.join(root, 'index.js') },
  );
  // Evaluated in a bare VM context so the assertion is about the emitted
  // expression, not about this test file's scope.
  const result = vm.runInNewContext(`${code}\nvalue;`, {});
  expect(result).toBe('MODULE_NOT_FOUND');
});

test('R2 fires only when nothing else would resolve', () => {
  const root = scratch();
  const filename = path.join(root, 'index.js');
  writeAddon(path.join(root, 'only.node'));
  expect(transform("require('./only');", { filename })).toContain(
    '_requireNodeLibrary',
  );

  // With a real .js sibling the require must be left alone.
  write(path.join(root, 'both.js'), 'module.exports = {};');
  writeAddon(path.join(root, 'both.node'));
  expect(transform("require('./both');", { filename })).toContain(
    "require('./both')",
  );

  // With a directory of that name, likewise.
  write(path.join(root, 'dir/index.js'), 'module.exports = {};');
  writeAddon(path.join(root, 'dir.node'));
  expect(transform("require('./dir');", { filename })).toContain(
    "require('./dir')",
  );

  // With a package.json in the directory, likewise.
  write(path.join(root, 'pkg/package.json'), '{"main":"x.js"}');
  writeAddon(path.join(root, 'pkg.node'));
  expect(transform("require('./pkg');", { filename })).toContain(
    "require('./pkg')",
  );
});

test('R3 rewrites a bare package whose main is an addon', () => {
  const root = scratch();
  const addon = path.join(root, 'node_modules/native-thing/index.node');
  write(
    path.join(root, 'node_modules/native-thing/package.json'),
    JSON.stringify({ name: 'native-thing', main: 'index.node' }),
  );
  writeAddon(addon);
  const code = transform("require('native-thing');", {
    filename: path.join(root, 'index.js'),
  });
  const [call] = callsIn(code);
  expect(call.key).toBe('node_modules/native-thing/index.node');
  expect(call.path).toBe(addon);
});

test('a bare package whose main is JavaScript is left alone', () => {
  const root = scratch();
  write(
    path.join(root, 'node_modules/plain-thing/package.json'),
    JSON.stringify({ name: 'plain-thing', main: 'index.js' }),
  );
  write(path.join(root, 'node_modules/plain-thing/index.js'), '');
  expect(
    transform("require('plain-thing');", {
      filename: path.join(root, 'index.js'),
    }),
  ).toContain("require('plain-thing')");
});

test('key: everything from the first node_modules segment', () => {
  const root = scratch();
  const addon = path.join(
    root,
    'node_modules/a/node_modules/b/prebuilds/x.node',
  );
  writeAddon(addon);
  expect(addonKey(addon)).toBe(
    'node_modules/a/node_modules/b/prebuilds/x.node',
  );
});

test('key: the local form for a path outside node_modules', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/addon.node');
  writeAddon(addon);
  const key = addonKey(addon);
  expect(key).toMatch(/^local\/[0-9a-f]{8}\/addon\.node$/u);
  expect(key).not.toContain('..');
  expect(key.startsWith('/')).toBe(false);
});

test('key: a symlinked package directory uses the real path', () => {
  const root = scratch();
  const real = path.join(root, 'real-package/prebuilds/x.node');
  write(filePathIn(root, 'real-package/package.json'), '{}');
  writeAddon(real);
  const link = path.join(root, 'node_modules/linked-package');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  // A symbolic link needs an elevated process or Developer Mode on Windows; a
  // directory junction needs neither and `fs.realpath` resolves it to the same
  // target, which is the behaviour under test.
  fs.symlinkSync(
    path.dirname(path.dirname(real)),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const code = transform("require('linked-package/prebuilds/x.node');", {
    filename: path.join(root, 'index.js'),
  });
  const [call] = callsIn(code);
  // The key comes from the real path (section 3.3), and a symlinked workspace
  // package resolves outside node_modules, so it takes the `local/` form —
  // the same key the real path produces when required directly, which is the
  // invariant that matters: one file, one key, whichever way it is reached.
  expect(call.key).toBe(addonKey(real));
  expect(call.key).toMatch(/^local\/[0-9a-f]{8}\/x\.node$/u);
});

test('embedPaths: false omits the second argument', () => {
  const root = scratch();
  writeAddon(path.join(root, 'addon.node'));
  const code = transform("require('./addon.node');", {
    filename: path.join(root, 'index.js'),
    embedPaths: false,
  });
  expect(code).toMatch(/_requireNodeLibrary\("[^"]+"\)/u);
  expect(callsIn(code)[0].path).toBeUndefined();
});

test('a binary for another platform is treated as missing', () => {
  const root = scratch();
  const addon = path.join(root, 'foreign.node');
  write(addon, foreignAddonHeader());
  expect(isHostPrebuiltNodeAddon(addon, process.platform, process.arch)).toBe(
    false,
  );
  const code = transform("require('./foreign.node');", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('MODULE_NOT_FOUND');
  expect(code).not.toContain('_requireNodeLibrary');
});

test('a path segment naming another platform is rejected without reading', () => {
  const root = scratch();
  // A segment naming a platform that is not the host's, so the guard rejects it
  // before it ever opens the file (the bytes written are the host's, which is
  // what makes this a test of the segment check rather than the header check).
  const foreign = process.platform === 'win32' ? 'linux' : 'win32';
  const foreignArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const addon = path.join(
    root,
    `prebuilds/${foreign}-${foreignArch}/thing.node`,
  );
  writeAddon(addon);
  expect(isHostPrebuiltNodeAddon(addon, process.platform, process.arch)).toBe(
    false,
  );
});

test('the host platform and arch are options, so tests run anywhere', () => {
  const root = scratch();
  const linuxX64 = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(linuxX64, 0);
  linuxX64.writeUInt16LE(0x3e, 18);
  const addon = path.join(root, 'linux.node');
  write(addon, linuxX64);

  expect(isHostPrebuiltNodeAddon(addon, 'linux', 'x64')).toBe(true);
  expect(isHostPrebuiltNodeAddon(addon, 'linux', 'arm64')).toBe(false);

  const code = transform("require('./linux.node');", {
    filename: path.join(root, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'x64',
  });
  expect(code).toContain('_requireNodeLibrary');

  const foreign = transform("require('./linux.node');", {
    filename: path.join(root, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'arm64',
  });
  expect(foreign).toContain('MODULE_NOT_FOUND');
});

test('a universal Mach-O with a host slice is accepted', () => {
  const root = scratch();
  const fat = Buffer.alloc(8 + 2 * 20);
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]).copy(fat, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8); // x86_64
  fat.writeUInt32BE(0x0100000c, 8 + 20); // arm64
  const addon = path.join(root, 'universal.node');
  write(addon, fat);
  expect(isHostPrebuiltNodeAddon(addon, 'darwin', 'arm64')).toBe(true);
  expect(isHostPrebuiltNodeAddon(addon, 'darwin', 'x64')).toBe(true);
});

test('a universal Mach-O without a host slice is rejected', () => {
  const root = scratch();
  const fat = Buffer.alloc(8 + 20);
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]).copy(fat, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x01000007, 8); // x86_64 only
  const addon = path.join(root, 'intel-only.node');
  write(addon, fat);
  expect(isHostPrebuiltNodeAddon(addon, 'darwin', 'arm64')).toBe(false);
  expect(isHostPrebuiltNodeAddon(addon, 'darwin', 'x64')).toBe(true);
});

test('resolveAddon reports a non-addon specifier as null', () => {
  const root = scratch();
  write(path.join(root, 'plain.js'), '');
  expect(
    resolveAddon('./plain', root, {
      hostPlatform: process.platform,
      hostArch: process.arch,
    }),
  ).toBeNull();
  expect(
    resolveAddon('react', root, {
      hostPlatform: process.platform,
      hostArch: process.arch,
    }),
  ).toBeNull();
});

test('a dynamic import and a computed require are left alone', () => {
  const root = scratch();
  writeAddon(path.join(root, 'addon.node'));
  const filename = path.join(root, 'index.js');
  expect(transform("import('./addon.node');", { filename })).toContain(
    "import('./addon.node')",
  );
  expect(transform('require(name);', { filename })).toContain('require(name)');
  expect(transform('require(`./addon.node`);', { filename })).toContain(
    'require(`./addon.node`)',
  );
});

test('the key never contains a backslash or a parent segment', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/addon.node');
  writeAddon(addon);
  const key = addonKey(addon);
  expect(key).not.toContain('\\');
  expect(key.split('/')).not.toContain('..');
});

function filePathIn(root, relative) {
  return path.join(root, relative);
}

// --- R4/R5/R6: packages that pick their binary at run time ------------------

/**
 * Writes a `prebuilds/<tag>/<name>.node` tree plus a package.json, the layout
 * `node-gyp-build` uses.
 */
function writeNodeGypBuildPackage(root, tags) {
  for (const tag of tags) {
    writeAddon(path.join(root, 'prebuilds', tag, 'thing.node'));
  }
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'gyp-thing', version: '1.0.0', main: 'index.js' }),
  );
}

/** The host's `node-gyp-build` tag, matching the plugin's own choice. */
function hostPrebuildTag() {
  return `${process.platform}-${process.arch}`;
}

test('R4 resolves require("node-gyp-build")(__dirname)', () => {
  const root = scratch();
  writeNodeGypBuildPackage(root, [hostPrebuildTag()]);
  const code = transform(
    "module.exports = require('node-gyp-build')(__dirname);",
    { filename: path.join(root, 'index.js') },
  );
  const [call] = callsIn(code);
  expect(call.path).toBe(
    path.join(root, 'prebuilds', hostPrebuildTag(), 'thing.node'),
  );
  expect(code).not.toContain('node-gyp-build');
});

test('R4 resolves path.join(__dirname, "sub")', () => {
  const root = scratch();
  const fixture = path.join(root, 'native');
  writeNodeGypBuildPackage(fixture, [hostPrebuildTag()]);
  const code = transform(
    "module.exports = require('node-gyp-build')(require('path').join(__dirname, 'native'));",
    { filename: path.join(root, 'index.js') },
  );
  expect(callsIn(code)[0].path).toBe(
    path.join(fixture, 'prebuilds', hostPrebuildTag(), 'thing.node'),
  );
});

test('R4 prefers the host tag over node.napi', () => {
  const root = scratch();
  writeNodeGypBuildPackage(root, [hostPrebuildTag(), 'node.napi']);
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)[0].path).toBe(
    path.join(root, 'prebuilds', hostPrebuildTag(), 'thing.node'),
  );
});

test('R4 falls back to an in-tree build/Release binary', () => {
  const root = scratch();
  writeAddon(path.join(root, 'build/Release/built.node'));
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'gyp-built', version: '1.0.0' }),
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)[0].path).toBe(
    path.join(root, 'build/Release/built.node'),
  );
});

test('R4 emits a throwing expression and warns when nothing resolves', () => {
  const root = scratch();
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'gyp-empty', version: '1.0.0' }),
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('MODULE_NOT_FOUND');
  expect(code).not.toContain('_requireNodeLibrary');
});

test('R4 ignores a dynamic directory argument', () => {
  const root = scratch();
  const code = transform("require('node-gyp-build')(someDir);", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain("require('node-gyp-build')(someDir)");
});

test('R5 resolves require("bindings")("thing")', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/thing.node');
  writeAddon(addon);
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'binding-thing', version: '1.0.0' }),
  );
  const code = transform("module.exports = require('bindings')('thing');", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)[0].path).toBe(addon);
  expect(code).not.toContain("require('bindings')");
});

test('R5 accepts the { bindings: name } form', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/thing.node');
  writeAddon(addon);
  const code = transform(
    "module.exports = require('bindings')({ bindings: 'thing' });",
    { filename: path.join(root, 'lib/index.js') },
  );
  expect(callsIn(code)[0].path).toBe(addon);
});

test('R5 searches upward for the package root, like bindings does', () => {
  const root = scratch();
  const addon = path.join(root, 'build/Release/thing.node');
  writeAddon(addon);
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'binding-thing', version: '1.0.0' }),
  );
  const code = transform("require('bindings')('thing');", {
    filename: path.join(root, 'lib/deep/index.js'),
  });
  expect(callsIn(code)[0].path).toBe(addon);
});

test('R5 emits a throwing expression when nothing resolves', () => {
  const root = scratch();
  write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'binding-empty', version: '1.0.0' }),
  );
  const code = transform("require('bindings')('missing');", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('MODULE_NOT_FOUND');
});

/** The napi-rs triple the plugin should choose for the host. */
function hostNapiRsTriple() {
  if (process.platform === 'linux') return `linux-${process.arch}-gnu`;
  if (process.platform === 'win32') return `win32-${process.arch}-msvc`;
  return `${process.platform}-${process.arch}`;
}

test('R6 replaces a napi-rs generated loader with one require', () => {
  const root = scratch();
  const triple = hostNapiRsTriple();
  // Three distinct platforms, none of which is the host's, so only the host
  // branch can resolve. The names must be ones the napi-rs triple scanner
  // recognises, otherwise this reads as a hand-written two-platform file and R6
  // never fires.
  const otherTriple = 'freebsd-x64';
  const thirdTriple = 'android-x64';
  writeAddon(path.join(root, `thing.${triple}.node`));
  writeAddon(path.join(root, `thing.${otherTriple}.node`));
  writeAddon(path.join(root, `thing.${thirdTriple}.node`));
  const loader = `
if (process.platform === '${process.platform}') {
  module.exports = require('./thing.${triple}.node');
} else if (process.platform === 'freebsd') {
  module.exports = require('./thing.${otherTriple}.node');
} else if (process.platform === 'android') {
  module.exports = require('./thing.${thirdTriple}.node');
} else {
  throw new Error('unsupported');
}
`;
  const code = transform(loader, { filename: path.join(root, 'index.js') });
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toBe(path.join(root, `thing.${triple}.node`));
  expect(code).toContain('module.exports');
  expect(code).not.toContain('process.platform');
});

test('R6 resolves the per-platform package form', () => {
  const root = scratch();
  // A Linux host named explicitly, so the package that has to exist is the
  // one the loader names for Linux regardless of where this test runs.
  const triple = 'linux-x64-gnu';
  const packageName = `@scope/thing-${triple}`;
  const addon = path.join(
    root,
    'node_modules/@scope',
    `thing-${triple}`,
    'thing.node',
  );
  // The host is named as linux/x64 below, so the bytes must be an ELF for x64
  // even when this test runs on macOS.
  writeAddonFor(addon, 'linux', 'x64');
  write(
    path.join(root, `node_modules/@scope/thing-${triple}/package.json`),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'thing.node' }),
  );
  const loader = `
if (process.platform === 'linux') {
  module.exports = require('@scope/thing-linux-x64-gnu');
} else if (process.platform === 'darwin') {
  module.exports = require('@scope/thing-darwin-arm64');
} else if (process.platform === 'win32') {
  module.exports = require('@scope/thing-win32-x64-msvc');
}
`;
  const code = transform(loader, {
    filename: path.join(root, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'x64',
  });
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toBe(addon);
});

test('R6 leaves a file that names fewer than three platforms to R1', () => {
  const root = scratch();
  // Two platforms only, so this is not a napi-rs loader and R1 alone rewrites
  // it. The host's own triple is one of them, so the rewrite really resolves.
  const hostTriple = hostNapiRsTriple();
  const foreignTriple = 'darwin-arm64';
  writeAddon(path.join(root, `thing.${hostTriple}.node`));
  writeAddonFor(
    path.join(root, `thing.${foreignTriple}.node`),
    'darwin',
    'arm64',
  );
  const source = `
if (process.platform === '${process.platform}') {
  module.exports = require('./thing.${hostTriple}.node');
} else {
  module.exports = require('./thing.${foreignTriple}.node');
}
`;
  const code = transform(source, { filename: path.join(root, 'index.js') });
  // Not a napi-rs loader, so the module body is untouched: the `process`
  // reference only means something where a platform branch survives, and R1
  // rewrote the requires it could resolve.
  expect(code).toContain(`process.platform === '${process.platform}'`);
  expect(code).toMatch(/module\.exports = _requireNodeLibrary\(/u);
});

test('R6 leaves a matching file alone when no host binary exists', () => {
  const root = scratch();
  const source = `
if (process.platform === 'freebsd') {
  module.exports = require('./thing.freebsd-x64.node');
} else if (process.platform === 'android') {
  module.exports = require('./thing.android-arm64.node');
} else if (process.platform === 'openharmony') {
  module.exports = require('./thing.openharmony-arm64.node');
}
`;
  const code = transform(source, { filename: path.join(root, 'index.js') });
  expect(code).not.toContain('_requireNodeLibrary');
});

test('R4/R5/R6 are no-ops off gpui', () => {
  const root = scratch();
  writeNodeGypBuildPackage(root, [hostPrebuildTag()]);
  const source = [
    "require('node-gyp-build')(__dirname);",
    "require('bindings')('thing');",
  ].join('\n');
  const code = transform(source, {
    filename: path.join(root, 'index.js'),
    platform: 'ios',
  });
  expect(code).toContain("require('node-gyp-build')(__dirname)");
  expect(code).toContain("require('bindings')('thing')");
  expect(code).not.toContain('_requireNodeLibrary');
});

test('R4/R6 use the hostPlatform/hostArch options', () => {
  const root = scratch();
  // `node-gyp-build` spells the Linux tag `linux-x64`; the napi-rs spelling
  // `linux-x64-gnu` is a different directory and must not be picked.
  const directory = path.join(root, 'linux-only');
  writeAddonFor(
    path.join(directory, 'prebuilds/linux-x64-gnu/thing.node'),
    'linux',
    'x64',
  );
  write(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'linux-only', version: '1.0.0' }),
  );
  const missing = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(directory, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'x64',
  });
  expect(missing).toContain('MODULE_NOT_FOUND');

  writeAddonFor(
    path.join(directory, 'prebuilds/linux-x64/thing.node'),
    'linux',
    'x64',
  );
  const resolved = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(directory, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'x64',
  });
  expect(callsIn(resolved)[0].path).toBe(
    path.join(directory, 'prebuilds/linux-x64/thing.node'),
  );
});

test('R4 handles path.resolve(__dirname), as bcrypt writes it', () => {
  const root = scratch();
  const tag = hostPrebuildTag();
  // bcrypt ships `prebuilds/<platform>-<arch>/<name>.node`, with a `glibc`
  // tag on Linux builds.
  const fileName =
    process.platform === 'linux' ? 'thing.glibc.node' : 'thing.node';
  if (process.platform === 'linux') {
    writeAddon(path.join(root, 'prebuilds', tag, fileName));
  } else {
    writeAddon(path.join(root, 'prebuilds', tag, fileName));
  }
  const code = transform(
    "const path = require('path');\nmodule.exports = require('node-gyp-build')(path.resolve(__dirname));",
    { filename: path.join(root, 'index.js') },
  );
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toBe(
    path.join(root, 'prebuilds', tag, fileName),
  );
});

test('R4 resolves path.resolve(__dirname, "sub")', () => {
  const root = scratch();
  const fixture = path.join(root, 'native');
  writeNodeGypBuildPackage(fixture, [hostPrebuildTag()]);
  const code = transform(
    "module.exports = require('node-gyp-build')(require('path').resolve(__dirname, 'native'));",
    { filename: path.join(root, 'index.js') },
  );
  expect(callsIn(code)[0].path).toBe(
    path.join(fixture, 'prebuilds', hostPrebuildTag(), 'thing.node'),
  );
});

test('R4 accepts a host arch inside a + joined directory', () => {
  const root = scratch();
  const platform = process.platform;
  const arch = process.arch;
  const other = arch === 'arm64' ? 'x64' : 'arm64';
  // The layout microtime ships: one universal binary for a two-arch directory.
  // The host arch is one of the two, so this is a valid host artifact.
  writeAddonFor(
    path.join(
      root,
      'prebuilds',
      `${platform}-${other}+${arch}`,
      'node.napi.node',
    ),
    platform,
    arch,
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toContain('node.napi.node');
});

test('R4 rejects a + joined directory that excludes the host arch', () => {
  const root = scratch();
  const platform = process.platform;
  const arch = process.arch;
  const other = arch === 'arm64' ? 'x64' : 'arm64';
  // Two architectures, neither of them the host's.
  writeAddon(
    path.join(
      root,
      'prebuilds',
      `${platform}-${other}+${other === 'x64' ? 'ia32' : 'x86'}`,
      'node.napi.node',
    ),
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('MODULE_NOT_FOUND');
});

test('R4 prefers a single-arch directory over a + joined one', () => {
  const root = scratch();
  const platform = process.platform;
  const arch = process.arch;
  // Both directories match the host; the one naming just this arch wins,
  // exactly as node-gyp-build compares tuples.
  writeAddon(path.join(root, 'prebuilds', `${platform}-${arch}`, 'thing.node'));
  writeAddon(
    path.join(root, 'prebuilds', `${platform}-other+${arch}`, 'thing.node'),
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)[0].path).toBe(
    path.join(root, 'prebuilds', `${platform}-${arch}`, 'thing.node'),
  );
});

test('R4 accepts a bare node.napi.node, which is runtime-agnostic', () => {
  const root = scratch();
  // A multi-arch directory holding only an ABI-agnostic N-API build, which is
  // what a package that targets Node, Electron and other hosts ships.
  writeAddon(
    path.join(
      root,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'node.napi.node',
    ),
  );
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toContain('node.napi.node');
});

test('R4 rejects an abi-tagged build, which is not an N-API host', () => {
  const root = scratch();
  const directory = path.join(
    root,
    'prebuilds',
    `${process.platform}-${process.arch}`,
  );
  // `node.abi115.node` is bound to Node's ABI, not to N-API, so it must not be
  // picked even though it is a valid binary for this CPU.
  writeAddon(path.join(directory, 'node.abi115.node'));
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('MODULE_NOT_FOUND');
});

test('R4 honours the glibc/musl file tag on Linux', () => {
  const root = scratch();
  const directory = path.join(root, 'prebuilds', 'linux-x64');
  writeAddonAt(path.join(directory, 'thing.glibc.node'), 'linux', 'x64');
  writeAddonAt(path.join(directory, 'thing.musl.node'), 'linux', 'x64');
  const code = transform("require('node-gyp-build')(__dirname);", {
    filename: path.join(root, 'index.js'),
    hostPlatform: 'linux',
    hostArch: 'x64',
  });
  // The test host is not Alpine, so the glibc build is the one node-gyp-build
  // would load there.
  expect(callsIn(code)[0].path).toBe(path.join(directory, 'thing.glibc.node'));
});

test('R7 resolves a require whose path is a template literal', () => {
  const root = scratch();
  const platform = process.platform;
  const arch = process.arch;
  const tag =
    platform === 'linux' ? `${platform}-${arch}` : `${platform}-${arch}`;
  // The farmhash layout: one binary per `<platform>-<arch>` under `build/`.
  writeAddonFor(path.join(root, 'build', `thing-${tag}.node`), platform, arch);
  writeAddon(
    path.join(root, 'build', 'thing-otheros-x64.node'),
    Buffer.alloc(0),
  );
  const code = transform(
    'module.exports = require(`./build/thing-${platform}-${arch}.node`);',
    { filename: path.join(root, 'index.js') },
  );
  expect(callsIn(code)).toHaveLength(1);
  expect(callsIn(code)[0].path).toBe(
    path.join(root, 'build', `thing-${tag}.node`),
  );
});

test('R7 skips a candidate naming a foreign target', () => {
  const root = scratch();
  // Only foreign builds exist, so R7 must not pick one.
  writeAddon(path.join(root, 'build', 'thing-win32-x64.node'));
  writeAddon(path.join(root, 'build', 'thing-linux-arm64.node'));
  const code = transform(
    'module.exports = require(`./build/thing-${platform}-${arch}.node`);',
    {
      filename: path.join(root, 'index.js'),
      hostPlatform: 'darwin',
      hostArch: 'arm64',
    },
  );
  expect(code).toContain('MODULE_NOT_FOUND');
});

test('R7 emits a throwing expression when no candidate exists', () => {
  const root = scratch();
  const code = transform(
    'module.exports = require(`./build/thing-${platform}.node`);',
    { filename: path.join(root, 'index.js') },
  );
  expect(code).toContain('MODULE_NOT_FOUND');
  expect(code).not.toContain('_requireNodeLibrary');
});

test('R7 leaves a template literal that is not a .node path alone', () => {
  const root = scratch();
  const code = transform('const x = `./data/${name}.json`;', {
    filename: path.join(root, 'index.js'),
  });
  expect(code).toContain('const x = `./data/${name}.json`');
});

// --- Part H: the host-binary check accepts only a host binary -----------------
//
// `isPeForArch` answers `null` for "not a PE file at all", `false` for "a PE for
// another machine" and `true` for a match. The caller used `!== false`, so a
// `null` — a Linux ELF or a macOS Mach-O — was accepted on a Windows host. The
// ELF and Mach-O branches already required `=== true`; these tests pin the same
// rule for Windows, and pin it on every host by naming the platform.

/** A file whose first bytes are not any known executable format. */
function notAnExecutable() {
  return Buffer.from('this is not a native addon, it is text', 'utf8');
}

test('on win32 an ELF file is rejected', () => {
  const root = scratch();
  const addon = path.join(root, 'linux.node');
  write(addon, elfHeader(0x3e));
  expect(isHostPrebuiltNodeAddon(addon, 'win32', 'x64')).toBe(false);
});

test('on win32 a Mach-O file is rejected', () => {
  const root = scratch();
  const addon = path.join(root, 'darwin.node');
  write(addon, machoHeader(0x01000007));
  expect(isHostPrebuiltNodeAddon(addon, 'win32', 'x64')).toBe(false);
});

test('on win32 a file that is not an executable at all is rejected', () => {
  const root = scratch();
  const addon = path.join(root, 'text.node');
  write(addon, notAnExecutable());
  // The case the bug let through: not a PE, so `isPeForArch` answers null.
  expect(isHostPrebuiltNodeAddon(addon, 'win32', 'x64')).toBe(false);
});

test('on win32 a PE for the other architecture is rejected', () => {
  const root = scratch();
  const addon = path.join(root, 'other-arch.node');
  write(addon, peHeader(0xaa64));
  expect(isHostPrebuiltNodeAddon(addon, 'win32', 'x64')).toBe(false);
});

test('on win32 a PE for the host architecture is accepted', () => {
  const root = scratch();
  const addon = path.join(root, 'host.node');
  write(addon, peHeader(0x8664));
  expect(isHostPrebuiltNodeAddon(addon, 'win32', 'x64')).toBe(true);
});

test('a rejected foreign binary becomes a MODULE_NOT_FOUND require', () => {
  const root = scratch();
  const addon = path.join(root, 'linux.node');
  write(addon, elfHeader(0x3e));
  const code = transform("require('./linux.node');", {
    filename: path.join(root, 'index.js'),
    hostPlatform: 'win32',
    hostArch: 'x64',
  });
  expect(code).toContain('MODULE_NOT_FOUND');
  expect(code).not.toContain('_requireNodeLibrary');
});
