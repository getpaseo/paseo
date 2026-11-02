#!/usr/bin/env node
// Builds the prebuilt C++ runtime for this host and packs it as
// prebuilt-binaries-<platform>.tar.gz with a manifest.json.
//
// Usage:
//   node scripts/build-prebuilt.mjs --version <v> --out <dir> \
//     [--bridge <cxxbridge-include> --rncore <generated-rncore-dir>] \
//     [--build-dir <dir>] [--native-deps <dir>] [--skip-build] [--jobs <n>]
//
// --bridge and --rncore are optional. When omitted, the cxxbridge headers and
// FBReactNativeSpec sources are generated (scripts/generate-prebuilt-inputs.mjs),
// so no tester build is needed. When given, they must be the generated
// directories of a `cargo build -p rn-gpui-sys` (files under
// `<target>/rn-gpui-cmake/<triple>/<build>/generated/`:
// `cxxbridge-include` and `fbreactnativespec`). --native-deps reuses
// downloaded native dependencies between runs.
//
// Output (under --out):
//   <platform>/                 the cmake --install prefix (lib/, include/, cmake/)
//   prebuilt-binaries-<platform>.tar.gz
//   prebuilt-binaries-<platform>.tar.gz.sha256
//   prebuilt-binaries-<platform>-pdb.tar.gz          Windows only
//   prebuilt-binaries-<platform>-pdb.tar.gz.sha256   Windows only

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputHash, overridesSha256 } from './prebuilt-inputs.mjs';
import { findNodeModule, repoRoot as findRepoRoot } from './repo-root.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repoRoot = findRepoRoot(scriptDir);
const cppDir = path.join(packageDir, 'ReactGpui', 'rn-gpui-sys', 'cpp');
const reactNativeRoot =
  findNodeModule(packageDir, 'react-native') ??
  path.join(repoRoot, 'node_modules', 'react-native');
const reactCommonDir = path.join(reactNativeRoot, 'ReactCommon');
const reactCxxPlatformDir = path.join(packageDir, 'ReactCxxPlatform');
const overridesDir = path.join(packageDir, 'ReactCommonOverrides');
const reactNativePkg = path.join(reactNativeRoot, 'package.json');
const cargoLock = path.join(packageDir, 'ReactGpui', 'Cargo.lock');

const args = parseArgs(process.argv.slice(2));
const version = args.version;
const outDir = path.resolve(args.out ?? fail('--out is required'));
// Without --bridge/--rncore the generated inputs are produced into the build
// dir (scripts/generate-prebuilt-inputs.mjs), so no tester build is needed.
const generatedDir = path.resolve(
  args['build-dir'] ?? path.join(os.tmpdir(), 'rn-gpui-prebuilt-build'),
  '..',
  'generated-inputs',
);
let bridgeDir = args.bridge ? path.resolve(args.bridge) : null;
let rncoreDir = args.rncore ? path.resolve(args.rncore) : null;
const buildDir = path.resolve(
  args['build-dir'] ?? path.join(os.tmpdir(), 'rn-gpui-prebuilt-build'),
);
// Source of the native-deps cache (OpenSSL, curl, folly sources). A fresh build
// dir cannot build OpenSSL apps/ on macOS, so the cache is linked in.
const nativeDepsSource = args['native-deps']
  ? path.resolve(args['native-deps'])
  : null;
const jobs =
  args.jobs ?? String(os.availableParallelism?.() ?? os.cpus().length);
if (!version) fail('--version is required');

const platform = hostPlatform();
const platformDir = path.join(outDir, platform);
const archiveName = `prebuilt-binaries-${platform}.tar.gz`;
const started = Date.now();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === 'skip-build') {
      out[name] = true;
    } else {
      out[name] = argv[++i];
    }
  }
  return out;
}

function fail(message) {
  console.error(`build-prebuilt: ${message}`);
  process.exit(2);
}

function hostPlatform() {
  const archMap = { arm64: 'arm64', x64: 'x64' };
  const arch = archMap[process.arch] ?? process.arch;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  if (process.platform === 'win32') return `win32-${arch}`;
  return `${process.platform}-${arch}`;
}

function run(cmd, cmdArgs, options = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status ?? result.signal}`);
  }
}

/**
 * A path as a CMake `-D` value.
 *
 * CMake parses a `-D` value as source text, so a Windows backslash starts an
 * escape and `-DFOO=C:\dir\gen` dies with "Invalid character escape '\g'".
 * Forward slashes are valid separators on Windows, so pass those.
 */
function cmakePath(value) {
  return path.resolve(value).split(path.sep).join('/');
}

/**
 * The `tar` to archive with.
 *
 * On Windows `tar` resolves to whatever is first on `PATH`, and Git for Windows
 * ships a GNU `tar` that reads `C:\...` as a remote host (`tar: Cannot connect
 * to C: resolve failed`), so archiving only works with the bsdtar in System32.
 * Prefer that by full path and fall back to the name for macOS and Linux, where
 * the first `tar` on `PATH` is the right one.
 */
function tarCommand() {
  if (process.platform === 'win32') {
    const system32 = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    );
    if (existsSync(system32)) return system32;
  }
  return 'tar';
}

/**
 * Links `target` at `linkPath`, or copies it when the platform will not make a
 * link.
 *
 * A directory symlink on Windows needs an elevated process or Developer Mode
 * (`EPERM: operation not permitted, symlink`), so a directory junction is used
 * instead, which any user may create. Both are transparent to the build: CMake
 * only reads the path. If neither works, copy, which always does.
 */
function linkDirectory(target, linkPath) {
  try {
    symlinkSync(
      target,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return;
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    console.log(
      `note: could not link ${linkPath} (${error.code}); copying instead`,
    );
  }
  cpSync(target, linkPath, { recursive: true });
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listFiles(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, root, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/// Absolute paths of every file under `dir` that `matches` accepts.
function findFiles(dir, matches) {
  const out = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (matches(full)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * Whether a PDB is CMake's link-time-optimisation probe rather than a target's
 * debug information.
 *
 * `_CMakeLTOTest-*` directories hold throwaway binaries CMake compiles to decide
 * whether the toolchain supports LTO. Their PDBs are named after the probe
 * sources (`boo.pdb`, `foo.pdb`, `vc143.pdb`), so several unrelated targets
 * collide on one name, and none of them describes a library in the archive.
 * CMake spells the directory with a leading underscore (`_CMakeLTOTest-CXX`).
 */
function isCmakeLtoTestArtifact(root, file) {
  return path
    .relative(root, file)
    .split(path.sep)
    .some(segment => /^_?CMakeLTOTest-/u.test(segment));
}

function sizeOfDir(dir) {
  let total = 0;
  for (const rel of listFiles(dir)) total += statSync(path.join(dir, rel)).size;
  return total;
}

function pkgVersion(file, key) {
  return JSON.parse(readFileSync(file, 'utf8'))[key];
}

function cargoLockVersion(name) {
  const text = readFileSync(cargoLock, 'utf8');
  const block = text
    .split('[[package]]')
    .find(b => b.includes(`name = "${name}"`));
  return block ? /version = "([^"]+)"/.exec(block)?.[1] : undefined;
}

/**
 * The compiler that built the archive, for the manifest.
 *
 * `c++ --version` is the Unix spelling; MSVC has no `c++` and spells the flag
 * `/Bv`, so asking for `--version` there leaves `stdout` undefined. Report
 * whatever the toolchain actually says, and fall back to a plain description
 * rather than crashing the whole archive build over a metadata string.
 */
function compilerVersion() {
  const [command, cmdArgs] =
    process.platform === 'win32'
      ? ['cl', ['/Bv']]
      : [process.env.CXX ?? 'c++', ['--version']];
  const result = spawnSync(command, cmdArgs, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const first = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)[0];
  return first ?? (process.platform === 'win32' ? 'cl' : 'unknown');
}

function libraryFiles(dir) {
  const libDir = path.join(dir, 'lib');
  if (!existsSync(libDir)) return [];
  return readdirSync(libDir)
    .filter(f => /\.(a|lib|so|dylib|dll)$|\.lib$/.test(f))
    .sort();
}

const configuration = 'Release';

// Release with light debug info so stacks symbolize without the ~1.8 GB of
// full debug libs. The consumer (build.rs) must match the runtime ABI:
//   - MSVC: /MD (MultiThreadedDLL) and _ITERATOR_DEBUG_LEVEL=0; PDBs ship
//     separately (prebuilt-binaries-win32-x64-pdb.tar.gz).
//   - clang/gcc: NDEBUG from Release, line tables only.
// These are recorded in the manifest `flags` field.
function buildFlags() {
  const isMsvc = process.platform === 'win32';
  const isGcc = !isMsvc && process.platform === 'linux';
  const debugCxx = isMsvc ? '/Zi' : isGcc ? '-g1' : '-gline-tables-only';
  // One section per function and per datum, so the linker can drop what an
  // executable never reaches. `cc` (which a source build goes through) adds
  // these itself; a prebuilt that omitted them behaved differently from a
  // source build in exactly one visible way: an unused C++ module's call into
  // the Rust module installers stayed live, and the `rn-gpui-sys` test binary
  // then failed to link `rn_gpui_fixture_badge_frame` on Linux. Rust links with
  // `--gc-sections` and reports only the undefined symbols that survive it, so
  // without per-function sections a single live function keeps a whole object.
  // MSVC has no equivalent flag; it dead-strips per function already.
  const sections = isMsvc ? [] : ['-ffunction-sections', '-fdata-sections'];
  const common = ['-w', ...sections];
  return {
    cxx: [...common, debugCxx],
    c: [...common, debugCxx],
    msvcRuntimeLibrary: isMsvc ? 'MultiThreadedDLL' : null,
    msvcIteratorDebugLevel: isMsvc ? '0' : null,
    debugInfo: isMsvc ? 'pdb-separate' : 'embedded-line-tables',
  };
}
const flags = buildFlags();
// MSVC needs the iterator-debug level as a compile definition; other toolchains
// get only the warning and debug flags.
const cxxFlags = [
  ...flags.cxx,
  ...(flags.msvcIteratorDebugLevel !== null
    ? [`/D_ITERATOR_DEBUG_LEVEL=${flags.msvcIteratorDebugLevel}`]
    : []),
].join(' ');
const cFlags = [
  ...flags.c,
  ...(flags.msvcIteratorDebugLevel !== null
    ? [`/D_ITERATOR_DEBUG_LEVEL=${flags.msvcIteratorDebugLevel}`]
    : []),
].join(' ');

if (!bridgeDir || !rncoreDir) {
  const generated = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'generate-prebuilt-inputs.mjs'), generatedDir],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (generated.status !== 0)
    fail('generating cxxbridge/FBReactNativeSpec failed');
  const [bridgeOut, rncoreOut] = generated.stdout.trim().split('\n');
  bridgeDir ??= bridgeOut;
  rncoreDir ??= rncoreOut;
}
if (!existsSync(path.join(bridgeDir, 'rust', 'cxx.h')))
  fail(`missing ${path.join(bridgeDir, 'rust', 'cxx.h')}`);
if (!existsSync(path.join(rncoreDir, 'jni')))
  fail(`missing ${path.join(rncoreDir, 'jni')}`);

if (!args['skip-build']) {
  mkdirSync(buildDir, { recursive: true });
  const linkedDeps = path.join(buildDir, 'native-deps');
  if (
    nativeDepsSource &&
    !existsSync(linkedDeps) &&
    existsSync(nativeDepsSource)
  ) {
    linkDirectory(nativeDepsSource, linkedDeps);
  }
  run('cmake', [
    '-S',
    cppDir,
    '-B',
    buildDir,
    `-DCMAKE_BUILD_TYPE=${configuration}`,
    // Cargo's cmake crate builds with -w (warnings suppressed); the prebuilt
    // matches it, since boost headers emit -Werror warnings under clang.
    `-DCMAKE_CXX_FLAGS=${cxxFlags}`,
    `-DCMAKE_C_FLAGS=${cFlags}`,
    ...(flags.msvcRuntimeLibrary
      ? [
          `-DCMAKE_MSVC_RUNTIME_LIBRARY=${flags.msvcRuntimeLibrary}`,
          '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
        ]
      : []),
    // curl's docs/man-page install rules need generated pages the source build
    // never makes. The prebuilt installs curl's headers and library itself.
    '-DCURL_DISABLE_INSTALL=ON',
    // Forward slashes: a `-D` value is parsed as a CMake string, where a
    // backslash starts an escape, so `-D...=C:\rn-gpui\...` fails at configure
    // time with "Invalid character escape '\g'". CMake accepts '/' on Windows
    // and `build.rs` normalises the same paths the same way.
    `-DRN_GPUI_PROJECT_ROOT=${cmakePath(repoRoot)}`,
    `-DREACT_COMMON_DIR=${cmakePath(reactCommonDir)}`,
    `-DREACT_CXX_PLATFORM_DIR=${cmakePath(reactCxxPlatformDir)}`,
    `-DRN_GPUI_OVERRIDES_DIR=${cmakePath(overridesDir)}`,
    `-DRN_GPUI_CXXBRIDGE_INCLUDE_DIR=${cmakePath(bridgeDir)}`,
    `-DRN_GPUI_GENERATED_RNCORE_DIR=${cmakePath(rncoreDir)}`,
  ]);
  run('cmake', [
    '--build',
    buildDir,
    '--target',
    'rn_gpui_core',
    '--parallel',
    jobs,
    '--config',
    configuration,
  ]);
}

rmSync(platformDir, { recursive: true, force: true });
mkdirSync(platformDir, { recursive: true });
run('cmake', [
  '--install',
  buildDir,
  '--config',
  configuration,
  '--prefix',
  platformDir,
]);

// Native-deps archives the build downloaded (DownloadNativeDeps.cmake), with
// their sha256, so consumers and CI can see exactly which sources a build used.
function nativeDepsArchives(dir) {
  const downloads = path.join(dir, 'native-deps', 'downloads');
  if (!existsSync(downloads)) return [];
  return readdirSync(downloads)
    .filter(name => !name.endsWith('.part'))
    .sort()
    .map(name => ({
      name,
      sha256: sha256File(path.join(downloads, name)),
    }));
}

const inputs = inputHash();
const files = {};
for (const rel of listFiles(platformDir)) {
  if (rel === 'manifest.json') continue;
  files[rel] = sha256File(path.join(platformDir, rel));
}
const manifest = {
  formatVersion: 1,
  version,
  inputHash: inputs.hash,
  sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim(),
  reactNative: pkgVersion(reactNativePkg, 'version'),
  triple: platform,
  cxxStdlib:
    process.platform === 'darwin'
      ? 'libc++'
      : process.platform === 'linux'
        ? 'libstdc++'
        : 'msvc',
  compiler: compilerVersion(),
  cxxStandard: 20,
  msvcRuntime: process.platform === 'win32' ? '/MD' : null,
  cxxCrate: cargoLockVersion('cxx'),
  cxxBridgeHeaderSha256: sha256File(
    path.join(bridgeDir, 'rn-gpui-sys', 'src', 'lib.rs.h'),
  ),
  overridesSha256: overridesSha256(),
  // Read by the consumer: the archive is Release, so its ReactCommon headers
  // select the production ABI. No engine define belongs here; the engine glue
  // is compiled by the app instead (see RN_GPUI_JS_ENGINE_* in cpp/CMakeLists.txt).
  defines: { REACT_NATIVE_DEBUG: 0 },
  flags,
  minOs: process.platform === 'darwin' ? 'macos 11.0' : null,
  glibc: process.platform === 'linux' ? '2.36' : null,
  libraries: libraryFiles(platformDir),
  // Headers are not shipped: consumers take them from node_modules/react-native,
  // this package, their own build.rs output, any installed engine package and
  // the native-deps downloads listed here. OpenSSL's generated headers are the only
  // exception (include/openssl-generated).
  nativeDeps: nativeDepsArchives(buildDir),
  files,
};
writeFileSync(
  path.join(platformDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const archivePath = path.join(outDir, archiveName);
rmSync(archivePath, { force: true });
run(tarCommand(), ['-czf', archivePath, '-C', outDir, platform]);
writeFileSync(
  `${archivePath}.sha256`,
  `${sha256File(archivePath)}  ${archiveName}\n`,
);

// Static libraries carry their debug information in PDB files that live next to
// the objects, not inside the archive, so the symbols are useless to a consumer
// unless they are published too. This is what the workflow's "Collect Windows
// PDBs" step does; doing it here means a local build produces the same two
// archives the release does. Collection is flat (one directory), as the
// workflow's is, because a debugger is given the PDB search path rather than a
// mirrored tree.
if (process.platform === 'win32') {
  const pdbDir = path.join(outDir, 'pdb');
  rmSync(pdbDir, { recursive: true, force: true });
  mkdirSync(pdbDir, { recursive: true });
  // A flat directory cannot hold two files with one name, so record what each
  // name already staged with; identical content is a harmless duplicate and
  // differing content is refused rather than silently dropped.
  const staged = new Map();
  let pdbCount = 0;
  for (const pdb of findFiles(
    buildDir,
    file =>
      path.extname(file) === '.pdb' && !isCmakeLtoTestArtifact(buildDir, file),
  )) {
    const name = path.basename(pdb);
    const previous = staged.get(name);
    if (previous !== undefined) {
      if (sha256File(previous) === sha256File(pdb)) continue;
      fail(
        `two different PDBs are both named ${name}:\n` +
          `  ${path.relative(buildDir, previous)}\n  ${path.relative(buildDir, pdb)}\n` +
          'The PDB archive is flat, so one would be lost.',
      );
    }
    staged.set(name, pdb);
    cpSync(pdb, path.join(pdbDir, name));
    pdbCount += 1;
  }
  if (pdbCount === 0) {
    fail(`no PDB files were produced under ${buildDir}`);
  }
  const pdbArchiveName = `prebuilt-binaries-${platform}-pdb.tar.gz`;
  const pdbArchivePath = path.join(outDir, pdbArchiveName);
  rmSync(pdbArchivePath, { force: true });
  run(tarCommand(), ['-czf', pdbArchivePath, '-C', pdbDir, '.']);
  writeFileSync(
    `${pdbArchivePath}.sha256`,
    `${sha256File(pdbArchivePath)}  ${pdbArchiveName}\n`,
  );
  console.log(`pdb archive ${pdbArchivePath} (${pdbCount} files)`);
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`archive ${archivePath} (${statSync(archivePath).size} bytes)`);
console.log(`installed tree ${platformDir} (${sizeOfDir(platformDir)} bytes)`);
console.log(`inputHash ${inputs.hash}`);
console.log(`build-prebuilt done in ${seconds}s`);
