// Babel plugin: turn `require('….node')` / `import … from '….node'` into
// `_requireNodeLibrary(key, path)` for the GPUI desktop runtime.
//
// On a phone an app may only load code that was embedded and signed at build
// time, so addons are discovered ahead of time and loaded through a shim. A
// desktop app has none of those restrictions: it can `dlopen` any file, so the
// stock `.node` binary a package publishes to npm loads unchanged. All this
// plugin does is tell the runtime which file to open and give it a stable name
// for that file.
//
// It is a no-op unless Babel's caller reports `platform === 'desktop'`, so one
// `babel.config.js` works for iOS, Android and desktop.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ELF magic and e_machine values, enough to tell a Linux addon for the host
// architecture from one built for another platform or CPU.
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

// Mach-O magics as the byte order they appear in the file:
//   CF FA ED FE / CE FA ED FE  64- and 32-bit thin, little-endian fields
//   FE ED FA CF / FE ED FA CE  the same, big-endian fields
//   CA FE BA BE                universal, big-endian table
//   BE BA FE CA                universal, little-endian table
const MACHO_THIN_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_THIN_LE_32 = Buffer.from([0xce, 0xfa, 0xed, 0xfe]);
const MACHO_THIN_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const MACHO_THIN_BE_32 = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
const MACHO_FAT_BE = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const MACHO_FAT_LE = Buffer.from([0xbe, 0xba, 0xfe, 0xca]);

// cputype values that mean "the host CPU" for each arch name.
const CPU_TYPES = {
  arm64: 0x0100000c,
  x64: 0x01000007,
  ia32: 0x00000007,
};

const ELF_MACHINE = {
  arm64: 0xb7,
  x64: 0x3e,
  ia32: 0x03,
};

/**
 * Platform markers that appear in a prebuild directory or file name, and the
 * host platform each one belongs to. A segment naming a *different* platform
 * is foreign; one naming the host's is not.
 */
const PLATFORM_MARKERS = {
  darwin: 'darwin',
  macos: 'darwin',
  osx: 'darwin',
  win32: 'win32',
  windows: 'win32',
  linux: 'linux',
  linuxmusl: 'linux',
  android: 'android',
  freebsd: 'freebsd',
  openharmony: 'openharmony',
};

/**
 * Whether a segment names a libc other than the host's. `musl` on a glibc host
 * cannot load (and the reverse), and neither can an `eabi`/`gnueabihf` ARM
 * variant on a soft-float host.
 */
function namesForeignLibc(segment) {
  return /\bmusl\b|musleabihf|musl-/u.test(segment);
}

/**
 * Whether a segment names a platform or CPU other than the host's. Architecture
 * tokens are compared after normalizing the common spellings, so `x86_64` and
 * `amd64` both become `x64` before the `x86` token could match and a plain
 * `linux-x64` segment is not mistaken for 32-bit.
 */
function namesForeignTarget(segment, hostPlatform, hostArch) {
  const lower = segment.toLowerCase();
  // A platform marker is only foreign when it is not the host's. `darwin` and
  // `linux` both appear in the paths the plugin is *supposed* to accept on
  // their own platform.
  for (const [marker, platform] of Object.entries(PLATFORM_MARKERS)) {
    if (!lower.includes(marker)) continue;
    if (platform !== hostPlatform) return true;
    // The host platform matched; a foreign libc in the same segment still
    // disqualifies it.
    if (namesForeignLibc(lower)) return true;
  }
  const tokens = lower
    .replace(/x86[_-]?64|amd64/gu, 'x64')
    .replace(/aarch64/gu, 'arm64')
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  // `ios` as a whole token: it would otherwise match unrelated names such as
  // `studios`.
  if (tokens.includes('ios') && hostPlatform !== 'ios') return true;
  const hostToken = hostArch === 'arm64' ? 'arm64' : 'x64';
  const archTokens = tokens.filter(token =>
    ['x64', 'arm64', 'arm', 'ia32', 'x86'].includes(token),
  );
  // A segment naming several architectures is a multi-arch artifact (a
  // `darwin-x64+arm64` prebuild directory, or one universal Mach-O file), so it
  // is foreign only when *none* of the architectures it names is the host's.
  // A segment naming exactly one is foreign when that one is not the host's.
  // The byte-level header check still has the final say for a thin binary.
  return archTokens.length > 0 && !archTokens.includes(hostToken);
}

function isElfForArch(header, arch) {
  if (!header.subarray(0, 4).equals(ELF_MAGIC)) return null;
  const machine = ELF_MACHINE[arch];
  if (machine === undefined) return false;
  return header.readUInt16LE(18) === machine;
}

// PE/COFF. A Windows binary starts with `MZ`; the 4-byte little-endian value at
// offset 0x3C is the file offset of the `PE\0\0` signature, and the 2-byte
// machine field follows it. Only the first 64 bytes of the file are read, so
// the signature is checked to be within that window before reading the machine.
const DOS_MAGIC = Buffer.from([0x4d, 0x5a]); // "MZ"
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"

const PE_MACHINE = {
  x64: 0x8664,
  arm64: 0xaa64,
  ia32: 0x014c,
};

/**
 * Whether a PE file is built for `arch`. Returns null when the bytes are not a
 * PE file at all, and true for an unrecognized machine value (an unusual-but
 * valid binary is never rejected, matching the Mach-O helper).
 *
 * The `PE\0\0` signature lives at the offset named by the 4-byte field at 0x3C,
 * which a normal linker places right after the 64-byte DOS header but is not
 * required to; `header` therefore only has to cover the offset named, and a
 * caller reading a short prefix reports "not a PE" rather than "wrong arch".
 */
function isPeForArch(header, arch) {
  if (header.length < 2 || !header.subarray(0, 2).equals(DOS_MAGIC)) {
    return null;
  }
  if (header.length < 0x40) return false;
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset + 6 > header.length) return false;
  if (!header.subarray(peOffset, peOffset + 4).equals(PE_SIGNATURE)) {
    return false;
  }
  const machine = header.readUInt16LE(peOffset + 4);
  const expected = PE_MACHINE[arch];
  if (expected === undefined) return true;
  if (machine === expected) return true;
  // 0x0 is IMAGE_FILE_MACHINE_UNKNOWN, which some linkers write; treat it as
  // acceptable rather than rejecting a working binary.
  return machine === 0x0000;
}

/**
 * Whether a Mach-O file contains a slice for `arch`. A thin file has one
 * cputype at offset 4; a universal file has a table of them after the 8-byte
 * header, each `fat_arch` starting with its own cputype. Anything we cannot
 * parse is accepted, so an unusual-but-valid binary is never rejected.
 */
function machoHasArch(header, arch) {
  const expected = CPU_TYPES[arch];
  if (expected === undefined) return false;
  const magic = header.subarray(0, 4);
  const isFat = magic.equals(MACHO_FAT_BE) || magic.equals(MACHO_FAT_LE);
  const read =
    magic.equals(MACHO_FAT_LE) ||
    magic.equals(MACHO_THIN_LE) ||
    magic.equals(MACHO_THIN_LE_32)
      ? offset => header.readUInt32LE(offset)
      : offset => header.readUInt32BE(offset);
  if (isFat) {
    if (header.length < 8) return true;
    const count = read(4);
    if (count === 0 || count > 64) return true;
    const fatEntrySize = 20;
    if (header.length < 8 + count * fatEntrySize) return true;
    for (let index = 0; index < count; index += 1) {
      if (read(8 + index * fatEntrySize) === expected) return true;
    }
    return false;
  }
  if (header.length < 8) return true;
  return read(4) === expected;
}

/**
 * Whether `filePath` is a shared library for the host. A file built for another
 * platform or CPU is treated as missing, so a package's per-platform binary
 * list does not make the bundle try to load one that cannot work.
 */
function isHostPrebuiltNodeAddon(filePath, hostPlatform, hostArch) {
  const segments = filePath.split(path.sep);
  if (
    segments.some(segment =>
      namesForeignTarget(segment, hostPlatform, hostArch),
    )
  ) {
    return false;
  }
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    // One window covers every header this function reads: ELF's and Mach-O's
    // first bytes, a universal Mach-O table, and a PE image whose `PE\0\0`
    // signature sits past the 64-byte DOS header plus a stub (MSVC places it
    // around 0xE8). Reading past the end of a short file is not an error.
    const header = Buffer.alloc(1024);
    const read = fs.readSync(handle, header, 0, header.length, 0);
    if (read < 20) return false;
    const headerBytes = header.subarray(0, read);
    if (hostPlatform === 'linux') {
      return isElfForArch(headerBytes, hostArch) === true;
    }
    if (hostPlatform === 'darwin') {
      const magic = headerBytes.subarray(0, 4);
      const known =
        magic.equals(MACHO_THIN_LE) ||
        magic.equals(MACHO_THIN_LE_32) ||
        magic.equals(MACHO_THIN_BE) ||
        magic.equals(MACHO_THIN_BE_32) ||
        magic.equals(MACHO_FAT_BE) ||
        magic.equals(MACHO_FAT_LE);
      if (!known) return false;
      return machoHasArch(headerBytes, hostArch);
    }
    if (hostPlatform === 'win32') {
      // `true` only, like the two branches above: `isPeForArch` returns null for
      // "not a PE file at all", and `null !== false` is true, so accepting
      // anything but an explicit rejection let a Linux `.node` or a macOS
      // Mach-O through on a Windows host.
      return isPeForArch(headerBytes, hostArch) === true;
    }
    // Platforms with no header check accept every file, which is the same as no
    // guard.
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * The stable, relative key for an addon (section 3.3 of the plan):
 *
 *   - if the real path has a `node_modules` segment, everything from the first
 *     `node_modules/` onward, with `/` separators;
 *   - otherwise `local/<first 8 hex of sha1(absolute path)>/<basename>`.
 *
 * The key is how a packaged app finds the addon after `node_modules` is gone,
 * so it must be portable: always `/`, never `..`, never a leading slash.
 */
function addonKey(absolutePath) {
  const normalized = absolutePath.split(path.sep).join('/');
  const marker = '/node_modules/';
  const index = normalized.indexOf(marker);
  const key =
    index === -1
      ? `local/${crypto
          .createHash('sha1')
          .update(normalized)
          .digest('hex')
          .slice(0, 8)}/${path.posix.basename(normalized)}`
      : normalized.slice(index + 1);
  if (
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').includes('..')
  ) {
    throw new Error(`invalid node addon key '${key}' for ${absolutePath}`);
  }
  return key;
}

/** Files Metro would resolve before an extensionless `.node` file. */
const RESOLVABLE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.ts', '.tsx'];

/**
 * Resolves a `require(`<prefix>${...}<suffix>.node`)` whose interpolated
 * segment is a platform/arch tag (R7). Packages such as `farmhash` build the
 * file name from `process.platform` and `process.arch` in a template literal,
 * which no run-time platform data can turn into a path here.
 *
 * The static prefix locates the directory; every `.node` file matching the
 * static suffix is a candidate, and the one usable on the host wins. That is
 * safe precisely because the tag is the only thing that varies: the candidate
 * set is exactly the set of platform builds the package ships.
 */
function resolveInterpolatedAddon(prefix, suffix, options) {
  const { hostPlatform, hostArch } = options;
  const directory = path.dirname(prefix);
  const basePrefix = path.basename(prefix);
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const candidates = entries
    .filter(
      entry =>
        entry.startsWith(basePrefix) &&
        entry.endsWith(suffix) &&
        entry.length > basePrefix.length + suffix.length,
    )
    .sort();
  for (const entry of candidates) {
    // The path segment named by the interpolated part must not name a foreign
    // target, and the bytes must be the host's.
    const middle = entry.slice(basePrefix.length, entry.length - suffix.length);
    if (namesForeignTarget(middle, hostPlatform, hostArch)) continue;
    const candidate = path.join(directory, entry);
    if (isHostPrebuiltNodeAddon(candidate, hostPlatform, hostArch)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Classifies a specifier written in `fromDirectory`:
 *
 *   { kind: 'addon', path }  a host `.node` file to load;
 *   { kind: 'missing' }      an explicit `.node` specifier with no usable file
 *                            (`missingModuleExpression` must stand in for it);
 *   null                     not an addon reference at all, so the require or
 *                            import is left exactly as written.
 *
 * The `missing` case exists because packages list a binary per platform and
 * wrap each in `try`/`catch`: the ones that are not installed must fail at run
 * time, not at bundle time.
 */
function resolveAddon(specifier, fromDirectory, options) {
  const { hostPlatform, hostArch } = options;
  const usable = filePath =>
    isHostPrebuiltNodeAddon(filePath, hostPlatform, hostArch) ? filePath : null;

  const tryFile = candidate => {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const resolved = usable(candidate);
      return resolved === null
        ? { kind: 'missing' }
        : { kind: 'addon', path: resolved };
    }
    return { kind: 'missing' };
  };

  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const isAbsolute = path.isAbsolute(specifier);

  // R1: an explicit `.node` specifier.
  if (specifier.endsWith('.node')) {
    if (isRelative || isAbsolute) {
      return tryFile(
        isAbsolute ? specifier : path.resolve(fromDirectory, specifier),
      );
    }
    // A bare specifier, either `pkg/x.node` or an addon a package lists in its
    // own manifest. `require.resolve` follows the package's own entry points.
    try {
      const resolved = require.resolve(specifier, { paths: [fromDirectory] });
      if (fs.statSync(resolved).isFile()) {
        const addonPath = usable(resolved);
        return addonPath === null
          ? { kind: 'missing' }
          : { kind: 'addon', path: addonPath };
      }
    } catch {}
    return { kind: 'missing' };
  }

  // R2: a relative specifier with no extension, where `<path>.node` exists and
  // nothing Metro would resolve first does.
  if (isRelative || isAbsolute) {
    const candidate = path.resolve(fromDirectory, specifier);
    if (
      RESOLVABLE_EXTENSIONS.some(extension =>
        fs.existsSync(candidate + extension),
      )
    ) {
      return null;
    }
    // A package.json or index file is a real module too.
    if (fs.existsSync(path.join(candidate, 'package.json'))) return null;
    for (const index of ['index.js', 'index.ts', 'index.tsx', 'index.json']) {
      if (fs.existsSync(path.join(candidate, index))) return null;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return null;
    }
    if (!fs.existsSync(`${candidate}.node`)) return null;
    return tryFile(`${candidate}.node`);
  }

  // R3: a bare package whose installed `main` (or `exports` entry) is an addon.
  try {
    const entry = require.resolve(specifier, { paths: [fromDirectory] });
    if (!entry.endsWith('.node')) return null;
    const addonPath = usable(entry);
    return addonPath === null
      ? { kind: 'missing' }
      : { kind: 'addon', path: addonPath };
  } catch {
    // Not installed here. A package a platform-specific branch would have
    // loaded is not our business; leave the require to Metro, which reports it
    // the same way it would for any missing module.
    return null;
  }
}

// --- R4–R6: packages that pick their binary at run time ---------------------
//
// Most packages do not write `require('./x.node')` themselves. They use a small
// loader that chooses the binary with `fs`, `path` and `process.platform` — none
// of which exist in Hermes. On desktop the build machine *is* the target, so the
// plugin can run that selection at build time instead, using the package's own
// data.

/** `node-gyp-build`'s own prebuild layout, plus the directories it probes. */
const NODE_GYP_BUILD_DIRECTORIES = [
  '.',
  'build',
  'build/Debug',
  'build/Release',
  'build/RelWithDebInfo',
  'build/MinSizeRel',
  'out',
];

/**
 * `prebuilds/<platform>-<arch>+<arch>` directory tags, as `node-gyp-build`
 * parses them. The arch list may be a `+`-joined union, which is how a package
 * ships one universal binary for two architectures.
 */
function parsePrebuildTuple(name) {
  const parts = name.split('-');
  if (parts.length !== 2) return null;
  const architectures = parts[1].split('+');
  if (
    !parts[0] ||
    architectures.length === 0 ||
    !architectures.every(Boolean)
  ) {
    return null;
  }
  return { name, platform: parts[0], architectures };
}

/**
 * The tags `node-gyp-build` reads out of a file name (`bcrypt.glibc.node`,
 * `node.napi.node`, `node.abi115.node`, `node.napi.armv8.node`).
 */
function parsePrebuildTags(file) {
  const parts = file.split('.');
  const extension = parts.pop();
  if (extension !== 'node') return null;
  const tags = { file, specificity: 0 };
  for (const tag of parts) {
    if (tag === 'node' || tag === 'electron' || tag === 'node-webkit') {
      tags.runtime = tag;
    } else if (tag === 'napi') {
      tags.napi = true;
    } else if (tag.startsWith('abi')) {
      tags.abi = tag.slice(3);
    } else if (tag.startsWith('uv')) {
      tags.uv = tag.slice(2);
    } else if (tag.startsWith('armv')) {
      tags.armv = tag.slice(4);
    } else if (tag === 'glibc' || tag === 'musl') {
      tags.libc = tag;
    } else {
      // An unknown tag carries no meaning to node-gyp-build.
      continue;
    }
    tags.specificity += 1;
  }
  return tags;
}

/**
 * Whether a parsed file matches this host. `node` + `napi` is
 * runtime-agnostic, so a `node.napi.node` loads in any N-API host; a plain
 * `abi<N>` tag is tied to the Node ABI and does not match us.
 */
function prebuildTagsMatchHost(tags, hostPlatform, hostArch) {
  if (tags === null) return false;
  // We are an N-API host with no Node ABI, so only `napi` (or no runtime/ABI
  // tag at all) qualifies. A `uv<N>` tag means the addon needs a libuv
  // version, which this runtime does not provide.
  if (tags.uv) return false;
  if (tags.abi && !tags.napi) return false;
  if (tags.armv) {
    const armv = hostArch === 'arm64' ? '8' : null;
    if (armv === null || tags.armv !== armv) return false;
  }
  if (tags.libc) {
    const hostLibc = hostPlatform === 'linux' ? linuxLibc() : null;
    if (hostLibc === null || tags.libc !== hostLibc) return false;
  }
  if (tags.runtime && tags.runtime !== 'node') return false;
  return true;
}

/**
 * Which libc this *build machine* uses, for the `glibc` / `musl` file tags.
 * Matches `node-gyp-build`'s own check (it looks for Alpine): the bundler runs
 * on the machine the app is built for, which is the whole premise of resolving
 * this at build time.
 */
function linuxLibc() {
  return fs.existsSync('/etc/alpine-release') ? 'musl' : 'glibc';
}

/**
 * Resolves `require('node-gyp-build')(<dir>)` at build time (R4).
 *
 * The plan asks for `node-gyp-build`'s own resolver rather than a copy of it,
 * and that is what runs first: its `path()` export is called with
 * `process.platform` / `process.arch` temporarily set to the host the bundle is
 * being built for. Both properties are configurable, so this always restores
 * them.
 *
 * It is only called when the requested host is the build host: `path()` also
 * reads the ABI and libuv versions of the *running* Node, which have no meaning
 * for a foreign target. For a cross-build, or when the package is not
 * installed, the resolver below reproduces the same algorithm against the
 * requested host. It is also the fallback when `path()` throws.
 */
function resolveNodeGypBuild(directory, options) {
  const { hostPlatform, hostArch } = options;
  if (hostPlatform === process.platform && hostArch === process.arch) {
    const viaNodeGypBuild = resolveWithNodeGypBuild(directory);
    if (viaNodeGypBuild !== null) return viaNodeGypBuild;
  }
  return resolvePrebuilds(directory, options);
}

/**
 * Runs the installed `node-gyp-build`'s `path()` for `directory`, with the
 * process's platform and architecture forced to the host. Returns null when the
 * package is not installed, when its resolver throws (its error message is the
 * only report it gives), or when it finds nothing usable.
 */
function resolveWithNodeGypBuild(directory) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  let resolved = null;
  try {
    Object.defineProperty(process, 'platform', {
      value: process.platform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: process.arch,
      configurable: true,
    });
    const nodeGypBuild = require(
      require.resolve('node-gyp-build', { paths: [directory, __dirname] }),
    );
    const candidate = nodeGypBuild.path(directory);
    if (
      typeof candidate === 'string' &&
      fs.existsSync(candidate) &&
      isHostPrebuiltNodeAddon(candidate, process.platform, process.arch) &&
      // `node-gyp-build`'s own resolver consults the *running* Node's
      // `process.versions`, and under recent Node versions it can settle on an
      // `electron.napi.node` build (it treats the absent
      // `process.versions.electron` as a match). An Electron ABI is not this
      // runtime's, so a file tagged with a runtime other than `node` is
      // rejected here and the ported resolver below picks the right one.
      !prefersForeignRuntime(candidate)
    ) {
      resolved = candidate;
    }
  } catch {
    resolved = null;
  } finally {
    // Restore whatever the properties were, descriptor and all.
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    } else {
      delete process.platform;
    }
    if (archDescriptor) {
      Object.defineProperty(process, 'arch', archDescriptor);
    } else {
      delete process.arch;
    }
  }
  return resolved;
}

/**
 * Whether a file name is tagged for a runtime this platform is not. Our runtime
 * is Hermes with Node-API; an Electron or NW.js build links a different ABI.
 */
function prefersForeignRuntime(file) {
  const tags = parsePrebuildTags(path.basename(file));
  return tags !== null && tags.runtime !== undefined && tags.runtime !== 'node';
}

/**
 * A faithful re-implementation of `node-gyp-build`'s selection, for a host that
 * is not the running process (or when its resolver cannot be reached).
 *
 * The order is its own: an in-tree `build/Release` or `build/Debug` binary
 * first, then a `prebuilds/` directory whose `<platform>-<arch...>` tuple
 * matches the host (single-arch preferred over a `+`-joined union), then the
 * most specific matching file tag.
 */
function resolvePrebuilds(directory, options) {
  const { hostPlatform, hostArch } = options;
  // node-gyp-build checks these before the prebuilds directory.
  for (const subdirectory of ['build/Release', 'build/Debug']) {
    const base = path.join(directory, subdirectory);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.node')) continue;
      const filePath = path.join(base, entry.name);
      if (isHostPrebuiltNodeAddon(filePath, hostPlatform, hostArch)) {
        return filePath;
      }
    }
  }

  const prebuildsRoot = path.join(directory, 'prebuilds');
  let tuples = [];
  try {
    tuples = fs
      .readdirSync(prebuildsRoot)
      .map(parsePrebuildTuple)
      .filter(Boolean)
      .filter(
        tuple =>
          tuple.platform === hostPlatform &&
          tuple.architectures.includes(hostArch),
      )
      // Fewer architectures means more specific; a `darwin-arm64` directory
      // beats a `darwin-x64+arm64` one.
      .sort((a, b) => a.architectures.length - b.architectures.length);
  } catch {
    tuples = [];
  }
  for (const tuple of tuples) {
    const prebuilds = path.join(prebuildsRoot, tuple.name);
    let parsed = [];
    try {
      parsed = fs.readdirSync(prebuilds).map(parsePrebuildTags);
    } catch {
      continue;
    }
    const winner = parsed
      .filter(tags => prebuildTagsMatchHost(tags, hostPlatform, hostArch))
      .sort((a, b) => {
        // An ABI-specific build is preferred over a plain napi one; with no
        // ABI of our own, that only ever picks `node.napi` last.
        if (Boolean(a.abi) !== Boolean(b.abi)) return a.abi ? -1 : 1;
        return b.specificity - a.specificity;
      })[0];
    if (!winner) continue;
    const candidate = path.join(prebuilds, winner.file);
    if (isHostPrebuiltNodeAddon(candidate, hostPlatform, hostArch)) {
      return candidate;
    }
  }

  // The in-tree builds and the plain `build/Release` layout.
  for (const subdirectory of NODE_GYP_BUILD_DIRECTORIES) {
    const base = path.join(directory, subdirectory);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.node')) continue;
      const filePath = path.join(base, entry.name);
      if (isHostPrebuiltNodeAddon(filePath, hostPlatform, hostArch)) {
        return filePath;
      }
    }
  }
  return null;
}

/**
 * The directories `bindings` searches, in its own order (R5). Read from its
 * source: it walks up from the calling module's directory looking for a
 * `package.json`, then tries these relative to each ancestor.
 */
const BINDINGS_DIRECTORIES = [
  'build/Release',
  'build/Debug',
  'build/RelWithDebInfo',
  'build/MinSizeRel',
  'out/Release',
  'out/Debug',
  'Release',
  'Debug',
  'Release/node-v',
  'Debug/node-v',
  'build',
  'out',
  'compiled',
  'addon-build/release/install-root',
  'addon-build/debug/install-root',
  'addon-build/default/install-root',
];

/**
 * Resolves `require('bindings')('<name>')` at build time (R5). `bindings`
 * searches upward from the package root for `package.json` and then tries each
 * candidate directory; this walks the same ancestors of `fromDirectory`.
 */
function resolveBindings(name, fromDirectory, options) {
  const { hostPlatform, hostArch } = options;
  let directory = fromDirectory;
  for (;;) {
    const candidates = [directory];
    const parent = path.dirname(directory);
    if (parent !== directory) candidates.push(parent);
    for (const base of candidates) {
      for (const subdirectory of BINDINGS_DIRECTORIES) {
        const target = path.join(base, subdirectory, name);
        for (const candidate of [target, `${target}.node`]) {
          try {
            if (!fs.statSync(candidate).isFile()) continue;
          } catch {
            continue;
          }
          if (isHostPrebuiltNodeAddon(candidate, hostPlatform, hostArch)) {
            return candidate;
          }
        }
      }
    }
    // `bindings` stops at the directory holding `package.json`, so a nested
    // call inside a package resolves against that package only.
    if (fs.existsSync(path.join(directory, 'package.json'))) break;
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * `process.platform` / `process.arch` as a napi-rs loader spells them in the
 * file name (`linux-x64-gnu`, `win32-arm64-msvc`). The host's own triple, from
 * most to least preferred: glibc beats musl on Linux, msvc beats gnu on
 * Windows.
 */
function napiRsTriples(hostPlatform, hostArch) {
  const platform = hostPlatform;
  if (platform === 'linux') {
    return [`linux-${hostArch}-gnu`, `linux-${hostArch}-musl`];
  }
  if (platform === 'win32') {
    return [`win32-${hostArch}-msvc`, `win32-${hostArch}-gnu`];
  }
  if (platform === 'darwin') {
    return [`darwin-${hostArch}`, 'darwin-universal'];
  }
  return [`${platform}-${hostArch}`];
}

/**
 * Detects a napi-rs generated loader and returns the binary it would pick (R6).
 *
 * The generated file is one big `if (process.platform === …)` chain whose
 * branches `require` either a local `<name>.<triple>.node` or a per-platform
 * package `<pkg>-<triple>`. Detection is a heuristic, per the plan: a module
 * with several `.node` requires for *different* platforms is one of these. When
 * a file matches but no host binary exists it is left untouched.
 */
function resolveNapiRsLoader(source, filename, options) {
  const { hostPlatform, hostArch } = options;
  const triples = napiRsTriples(hostPlatform, hostArch);
  // Every triple named in the file, so a non-loader that happens to require a
  // couple of binaries is not misread.
  const mentioned = new Set();
  const triplePattern =
    /\b(?:darwin|linux|win32|android|freebsd|openharmony)-(?:x64|arm64|arm|ia32|loong64|riscv64|ppc64|s390x)(?:-(?:gnu|musl|msvc|eabi|gnueabihf|musleabihf))?\b/gu;
  for (const match of source.matchAll(triplePattern)) {
    mentioned.add(match[0]);
  }
  // A napi-rs loader names at least three platforms; a hand-written file that
  // happens to name two is left alone.
  const platforms = new Set([...mentioned].map(triple => triple.split('-')[0]));
  if (platforms.size < 3) return null;

  const directory = path.dirname(filename);
  // The local copy first, exactly as the loader tries it.
  for (const triple of triples) {
    const local = path.join(directory, `${triple}.node`);
    if (fs.existsSync(local)) {
      if (isHostPrebuiltNodeAddon(local, hostPlatform, hostArch)) return local;
    }
    // `<name>.<triple>.node` for any prefix the file uses.
    let entries = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(`.${triple}.node`)) continue;
      const filePath = path.join(directory, entry);
      if (isHostPrebuiltNodeAddon(filePath, hostPlatform, hostArch)) {
        return filePath;
      }
    }
  }

  // Then the per-platform packages, whose own entry is the `.node` file itself.
  const scoped = /require\((['"])(@[^'"]+|[^'"./][^'"]*)\1\)/gu;
  const packageNames = new Set();
  for (const match of source.matchAll(scoped)) {
    packageNames.add(match[2]);
  }
  for (const triple of triples) {
    for (const packageName of packageNames) {
      if (!packageName.endsWith(triple)) continue;
      try {
        const entry = require.resolve(packageName, { paths: [directory] });
        if (
          entry.endsWith('.node') &&
          isHostPrebuiltNodeAddon(entry, hostPlatform, hostArch)
        ) {
          return entry;
        }
      } catch {}
    }
  }
  return null;
}

module.exports = function babelPluginNodeAddons(api, options = {}) {
  const t = api.types;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const embedPaths = options.embedPaths !== false;
  const pluginOptions = { hostPlatform, hostArch };
  // Resolving a bare specifier costs a `require.resolve`, and the visitor sees
  // every literal `require` in the bundle, so the answer is memoised per file
  // directory and specifier.
  const resolutionCache = new Map();
  // One warning per (file, reason), so a loader in a widely-imported module
  // does not fill the bundler's output.
  const warned = new Set();
  const warnOnce = (state, message) => {
    const key = `${state.file.opts.filename}\u0000${message}`;
    if (warned.has(key)) return;
    warned.add(key);
    state.file.metadata.rnGpuiNodeAddonWarnings ??= [];
    state.file.metadata.rnGpuiNodeAddonWarnings.push(message);
    // `console` is all a Babel plugin has; Metro shows it with the file name.
    console.warn(`[react-native-gpui/babel-plugin-node-addons] ${message}`);
  };
  // Read once, at config time: `api.caller` caches the answer and refuses a
  // callback once traversal has started.
  const isGpuiPlatform = api.caller(caller => caller?.platform) === 'desktop';

  const missingModuleExpression = specifier => {
    const error = t.callExpression(t.identifier('Error'), [
      t.stringLiteral(`Cannot find module '${specifier}'`),
    ]);
    // (() => { const error = new Error(...); error.code = 'MODULE_NOT_FOUND';
    //         throw error; })()
    return t.callExpression(
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(t.identifier('error'), error),
          ]),
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(t.identifier('error'), t.identifier('code')),
              t.stringLiteral('MODULE_NOT_FOUND'),
            ),
          ),
          t.throwStatement(t.identifier('error')),
        ]),
      ),
      [],
    );
  };

  const requireNodeLibraryCall = resolvedPath => {
    const key = addonKey(fs.realpathSync(resolvedPath));
    const args = [t.stringLiteral(key)];
    if (embedPaths) args.push(t.stringLiteral(resolvedPath));
    return t.callExpression(t.identifier('_requireNodeLibrary'), args);
  };

  /**
   * The expression an addon reference becomes. `null` means the specifier is
   * not an addon reference after all and must be left alone.
   */
  const addonExpression = (specifier, fromDirectory) => {
    const cacheKey = `${fromDirectory}\u0000${specifier}`;
    let resolution = resolutionCache.get(cacheKey);
    if (resolution === undefined) {
      resolution = resolveAddon(specifier, fromDirectory, pluginOptions);
      resolutionCache.set(cacheKey, resolution);
    }
    if (resolution === null) return null;
    if (resolution.kind === 'missing')
      return missingModuleExpression(specifier);
    return requireNodeLibraryCall(resolution.path);
  };

  /** The directory argument of a `node-gyp-build`-style call, if static. */
  const staticDirectoryArgument = (argument, fromDirectory) => {
    if (argument === undefined) return null;
    // `__dirname`
    if (argument.type === 'Identifier' && argument.name === '__dirname') {
      return fromDirectory;
    }
    // `path.join(__dirname, 'literal', ...)` or `path.resolve(...)`, either
    // reached bare or through the module: `require('path').join(...)`.
    if (argument.type === 'CallExpression') {
      const callee = argument.callee;
      if (
        callee.type !== 'MemberExpression' ||
        callee.property.type !== 'Identifier' ||
        (callee.property.name !== 'join' && callee.property.name !== 'resolve')
      ) {
        return null;
      }
      const isPathModule = object =>
        (object.type === 'Identifier' && object.name === 'path') ||
        (object.type === 'CallExpression' &&
          object.callee.type === 'Identifier' &&
          object.callee.name === 'require' &&
          object.arguments.length === 1 &&
          object.arguments[0].type === 'StringLiteral' &&
          object.arguments[0].value === 'path');
      if (!isPathModule(callee.object)) return null;
      const parts = [];
      let base = null;
      for (const part of argument.arguments) {
        if (part.type === 'StringLiteral') {
          parts.push(part.value);
        } else if (part.type === 'Identifier' && part.name === '__dirname') {
          base = fromDirectory;
        } else {
          return null;
        }
      }
      if (base === null) return null;
      return path.resolve(base, ...parts);
    }
    return null;
  };

  /** The string argument of a `bindings('<name>')` call, if static. */
  const staticBindingsName = argument => {
    if (argument === undefined) return null;
    if (argument.type === 'StringLiteral') return argument.value;
    // `{ bindings: '<name>' }`
    if (argument.type === 'ObjectExpression') {
      for (const property of argument.properties) {
        if (
          property.type === 'ObjectProperty' &&
          !property.computed &&
          property.key.type === 'Identifier' &&
          property.key.name === 'bindings' &&
          property.value.type === 'StringLiteral'
        ) {
          return property.value.value;
        }
      }
    }
    return null;
  };

  /**
   * R4/R5: recognises `require('node-gyp-build')(<dir>)` and
   * `require('bindings')(<name>)` and returns the expression that replaces the
   * whole call, or `null` when resolution failed (a throwing expression is
   * emitted and one warning printed), or `undefined` when the node is not one
   * of these calls at all.
   */
  const loaderCallExpression = (node, fromDirectory, state) => {
    // The outer call is `require('x')(...)`: its callee is the inner `require`.
    if (node.callee.type !== 'CallExpression') return undefined;
    const inner = node.callee;
    if (
      inner.callee.type !== 'Identifier' ||
      inner.callee.name !== 'require' ||
      inner.arguments.length !== 1 ||
      inner.arguments[0].type !== 'StringLiteral'
    ) {
      return undefined;
    }
    const loaderName = inner.arguments[0].value;
    if (loaderName === 'node-gyp-build') {
      const directory = staticDirectoryArgument(
        node.arguments[0],
        fromDirectory,
      );
      if (directory === null) return undefined;
      const resolved = resolveNodeGypBuild(directory, pluginOptions);
      if (resolved !== null) return requireNodeLibraryCall(resolved);
      warnOnce(
        state,
        `node-gyp-build: no ${pluginOptions.hostPlatform}-${pluginOptions.hostArch} binary under ${directory}`,
      );
      return missingModuleExpression('node-gyp-build');
    }
    if (loaderName === 'bindings') {
      const name = staticBindingsName(node.arguments[0]);
      if (name === null) return undefined;
      const resolved = resolveBindings(name, fromDirectory, pluginOptions);
      if (resolved !== null) return requireNodeLibraryCall(resolved);
      warnOnce(
        state,
        `bindings: no ${pluginOptions.hostPlatform}-${pluginOptions.hostArch} binary named '${name}' from ${fromDirectory}`,
      );
      return missingModuleExpression('bindings');
    }
    return undefined;
  };

  return {
    name: 'react-native-gpui-node-addons',
    visitor: {
      CallExpression(nodePath, state) {
        if (!isGpuiPlatform) return;
        const { node } = nodePath;
        const filename = state.file.opts.filename;
        if (typeof filename !== 'string' || filename === 'unknown') return;
        const fromDirectory = path.dirname(filename);

        // R4/R5: the whole loader call is replaced, so it is matched before the
        // `require` inside it — `require('node-gyp-build')(__dirname)` would
        // otherwise be visited on the way down and left as it is anyway, since
        // neither specifier ends in `.node`.
        const loader = loaderCallExpression(node, fromDirectory, state);
        if (loader !== undefined) {
          if (loader === null) return;
          nodePath.replaceWith(loader);
          return;
        }

        if (
          node.callee.type !== 'Identifier' ||
          node.callee.name !== 'require' ||
          node.arguments.length !== 1
        ) {
          return;
        }

        // R7: `require(`./build/thing-${platform}.node`)`, where the
        // interpolated segments are platform/arch tags. The static prefix and
        // suffix locate the candidates; the tags themselves cannot be
        // evaluated. Any number of interpolations is allowed as long as the
        // suffix still ends in `.node` — the glob between prefix and suffix
        // absorbs them all.
        if (node.arguments[0].type === 'TemplateLiteral') {
          if (nodePath.parentPath.isCallExpression({ callee: node })) return;
          const { quasis } = node.arguments[0];
          if (node.arguments[0].expressions.length === 0) return;
          const prefix = quasis[0].value.cooked ?? quasis[0].value.raw;
          const suffix =
            quasis[quasis.length - 1].value.cooked ??
            quasis[quasis.length - 1].value.raw;
          if (!suffix.endsWith('.node') || !prefix.startsWith('.')) return;
          const resolved = resolveInterpolatedAddon(
            path.resolve(fromDirectory, prefix),
            suffix,
            pluginOptions,
          );
          if (resolved === null) {
            warnOnce(
              state,
              `no ${pluginOptions.hostPlatform}-${pluginOptions.hostArch} file matches ${prefix}…${suffix}`,
            );
            nodePath.replaceWith(
              missingModuleExpression(`${prefix}…${suffix}`),
            );
            return;
          }
          nodePath.replaceWith(requireNodeLibraryCall(resolved));
          return;
        }

        if (node.arguments[0].type !== 'StringLiteral') return;
        const specifier = node.arguments[0].value;
        // A dynamic `import()` is a different node type entirely, and the
        // `require` a bundler synthesises from it is not what this rewrites.
        if (nodePath.parentPath.isCallExpression({ callee: node })) return;
        const expression = addonExpression(specifier, path.dirname(filename));
        // `addonExpression` returns null when the specifier turned out not to
        // name an addon, so every other require is left for Metro.
        if (expression === null) return;
        nodePath.replaceWith(expression);
      },

      // R6: a napi-rs generated loader is replaced as a whole module, since
      // every branch of its `process.platform` chain is dead here.
      Program(nodePath, state) {
        if (!isGpuiPlatform) return;
        const filename = state.file.opts.filename;
        if (typeof filename !== 'string' || filename === 'unknown') return;
        // Babel hands the original source here even when the transform was
        // given a string rather than a file, which is how the unit tests drive
        // it; the on-disk file name is still what relative requires resolve
        // against.
        const source = state.file.code;
        if (typeof source !== 'string') return;
        // Cheap gate before the full check: a napi-rs loader always branches
        // on the platform.
        if (!/(?:process\.platform|process\.config)/u.test(source)) return;
        const resolved = resolveNapiRsLoader(source, filename, pluginOptions);
        if (resolved === null) return;
        for (const statement of nodePath.get('body')) {
          statement.remove();
        }
        nodePath.pushContainer(
          'body',
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(
                t.identifier('module'),
                t.identifier('exports'),
              ),
              requireNodeLibraryCall(resolved),
            ),
          ),
        );
      },

      ImportDeclaration(nodePath, state) {
        if (!isGpuiPlatform) return;
        const { node } = nodePath;
        if (
          typeof node.source.value !== 'string' ||
          !/\.node$/u.test(node.source.value)
        ) {
          return;
        }
        const filename = state.file.opts.filename;
        if (typeof filename !== 'string' || filename === 'unknown') return;
        const specifier = node.source.value;
        const expression = addonExpression(specifier, path.dirname(filename));
        if (expression === null) return;

        // Every form binds the same exports object: a default import is the
        // object itself, a namespace import is the object itself, and named
        // imports are destructured from it.
        const statements = [];
        const shared = t.identifier('_nodeAddonExports');
        const named = node.specifiers.filter(
          item => item.type === 'ImportSpecifier' && item.imported,
        );
        const bound = node.specifiers.filter(
          item =>
            item.type === 'ImportDefaultSpecifier' ||
            item.type === 'ImportNamespaceSpecifier',
        );
        const needsShared = bound.length > 0 || named.length > 0;
        if (needsShared) {
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(shared, expression),
            ]),
          );
        }
        for (const item of bound) {
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(item.local, shared),
            ]),
          );
        }
        if (named.length > 0) {
          statements.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.objectPattern(
                  named.map(item =>
                    t.objectProperty(item.imported, item.local),
                  ),
                ),
                shared,
              ),
            ]),
          );
        }
        if (statements.length === 0) {
          // A bare `import 'x.node'` still has to load the addon.
          statements.push(t.expressionStatement(expression));
        }
        nodePath.replaceWithMultiple(statements);
      },
    },
  };
};

module.exports.addonKey = addonKey;
module.exports.isHostPrebuiltNodeAddon = isHostPrebuiltNodeAddon;
module.exports.resolveAddon = resolveAddon;
