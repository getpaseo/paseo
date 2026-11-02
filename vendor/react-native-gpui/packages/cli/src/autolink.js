import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// npm ships npx as a .cmd shim on Windows, where child_process cannot resolve a
// command without its extension, and Node refuses to spawn .cmd/.bat files
// without a shell (the CVE-2024-27980 fix), so npx runs through the shell
// there. A shell joins the arguments into one command line, so arguments with
// spaces are quoted here first.
export const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
export const npxShell = process.platform === 'win32';
export const npxArgs = args =>
  npxShell ? args.map(arg => (/\s/u.test(arg) ? `"${arg}"` : arg)) : args;

/**
 * Write a generated file only when its content differs. Cargo and CMake go by
 * modification time, so rewriting an identical file makes every launch rebuild
 * the C++ bridge and each crate that depends on it.
 */
function writeIfChanged(file, contents) {
  try {
    if (fs.readFileSync(file, 'utf8') === contents) return;
  } catch {}
  fs.writeFileSync(file, contents);
}

const findCppSources = directory => {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findCppSources(entryPath);
    return /\.(?:cc|cpp|cxx)$/u.test(entry.name) ? [entryPath] : [];
  });
};

/// Crates a module crate must depend on by version, never by path or git.
///
/// They live under `@react-native-gpui/core` at a path that only exists inside
/// this repository. A published module crate resolves relative paths from
/// `node_modules/@react-native-gpui/<name>/desktop`, where `../../../packages`
/// is nowhere. So the crate names a crates.io version and autolink patches it,
/// in the app's root manifest, to the core that is actually installed.
const MANAGED_CRATES = [
  'react-native-gpui',
  'rn-gpui-sys',
  'rn-gpui-module',
  'rn-gpui-module-build',
  'gpui',
  'gpui_platform',
];

/// The version each managed crate is patched to, when it is a path dependency.
const CORE_CRATE_VERSION = '0.1';

const PATCH_BEGIN =
  '# Managed by @react-native-gpui/cli autolink; do not edit between these markers.';
const PATCH_END = '# End managed by autolink.';

/**
 * The gpui pin, read from core's manifest.
 *
 * Core owns the revision (`GPUI_PIN.md` says so), and a module that copied it
 * would drift the moment the pin moved. The npm package ships `ReactGpui`, so
 * the manifest is always beside the installed crate.
 */
function gpuiPin(platformRoot) {
  const manifest = path.join(platformRoot, 'ReactGpui/Cargo.toml');
  let text;
  try {
    // Normalised for consistency with the lockfile read below. This pattern
    // happens to survive CRLF on its own, because `\s*$` treats `\r` as
    // whitespace, but relying on that is a trap for the next edit.
    text = fs.readFileSync(manifest, 'utf8').replace(/\r\n/gu, '\n');
  } catch (error) {
    throw new Error(
      `could not read the gpui pin from ${manifest}: ${error.message}`,
    );
  }
  const workspace = /^\[workspace\.dependencies\]\s*$/mu.exec(text);
  if (workspace === null) {
    throw new Error(`${manifest} has no [workspace.dependencies] table`);
  }
  const start = workspace.index;
  const nextTable = text.indexOf('\n[', start + 1);
  const table = text.slice(start, nextTable < 0 ? text.length : nextTable);
  const pin = name => {
    const line = new RegExp(`^${name}\\s*=\\s*\\{([^}]*)\\}`, 'mu').exec(table);
    if (line === null) {
      throw new Error(
        `${manifest} declares no ${name} in [workspace.dependencies]`,
      );
    }
    const git = /git\s*=\s*"([^"]+)"/u.exec(line[1]);
    const rev = /rev\s*=\s*"([^"]+)"/u.exec(line[1]);
    if (git === null || rev === null) {
      throw new Error(
        `${manifest}: ${name} is not a git dependency with a rev`,
      );
    }
    return { git: git[1], rev: rev[1] };
  };
  return { gpui: pin('gpui'), gpuiPlatform: pin('gpui_platform') };
}

/**
 * The managed `[patch.crates-io]` block, or the text to append.
 *
 * `[patch]` only takes effect in the root manifest, which is why this is written
 * into the app rather than into each module crate.
 */
function patchBlock(entries) {
  return [
    PATCH_BEGIN,
    ...entries.map(([name, spec]) => `${name} = ${spec}`),
    PATCH_END,
  ].join('\n');
}

/**
 * A TOML string literal for a value.
 *
 * JSON's string syntax is a subset of TOML's for the characters paths contain, so
 * quoting through it keeps a Windows path's backslashes escaped correctly.
 */
function escapeToml(value) {
  return JSON.stringify(value);
}

/**
 * The `[patch.crates-io]` entries that point every managed crate at core.
 *
 * Exported because a second root manifest needs the same table: a module crate
 * that declares `[workspace]` to become testable is its own root, and Cargo
 * honours `[patch]` only there. Copying the block by hand reintroduces exactly
 * the drift these entries exist to prevent — the gpui revision is read from
 * core's manifest here, not written down anywhere.
 *
 * `platformRoot` is the installed core package, whose gated gpui pin is the
 * authority; `base` is the directory the paths are written relative to, which
 * for an app manifest is its `desktop/` directory.
 */
export function managedPatchEntries(platformRoot, base) {
  const runtimeCrate = path.join(platformRoot, 'ReactGpui/rn-gpui');
  const pin = gpuiPin(platformRoot);
  const relative = target =>
    escapeToml(path.relative(base, target).split(path.sep).join('/'));
  return [
    ...MANAGED_CRATES.filter(
      crate => crate !== 'gpui' && crate !== 'gpui_platform',
    ).map(crate => [
      crate,
      // The directory is not always the crate name: `react-native-gpui` lives
      // in `rn-gpui`, so the path is built from the directory, not the key.
      `{ path = ${relative(
        crate === 'react-native-gpui'
          ? runtimeCrate
          : path.join(path.dirname(runtimeCrate), crate),
      )} }`,
    ]),
    ['gpui', `{ git = "${pin.gpui.git}", rev = "${pin.gpui.rev}" }`],
    [
      'gpui_platform',
      `{ git = "${pin.gpuiPlatform.git}", rev = "${pin.gpuiPlatform.rev}" }`,
    ],
  ];
}

/**
 * Insert or replace the managed block in an app manifest.
 *
 * Idempotent: a second run must produce the same bytes, because `writeIfChanged`
 * depends on it and a rewritten manifest makes Cargo rebuild everything.
 */
export function applyPatchBlock(manifest, manifestPath, entries) {
  const block = patchBlock(entries);
  const managed = new RegExp(
    `${PATCH_BEGIN.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[\\s\\S]*?${PATCH_END.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
    'u',
  );
  if (managed.test(manifest)) {
    return manifest.replace(managed, block);
  }

  const header = /^\[patch\.crates-io\]\s*$/mu.exec(manifest);
  if (header !== null) {
    // A table the user wrote. Cargo rejects a second header, so the block goes
    // inside theirs — but a duplicate key would make the manifest invalid, and
    // silently overwriting their line would be worse, so that is an error.
    const start = header.index;
    const nextTable = manifest.indexOf('\n[', start + 1);
    const end = nextTable < 0 ? manifest.length : nextTable;
    const body = manifest.slice(start, end);
    for (const [name] of entries) {
      if (new RegExp(`^${name}\\s*=`, 'mu').test(body)) {
        throw new Error(
          `${manifestPath}: [patch.crates-io] already sets ${name}, which autolink owns; remove that line so it can be managed`,
        );
      }
    }
    const headerEnd = start + header[0].length;
    return `${manifest.slice(0, headerEnd)}\n${block}${manifest.slice(headerEnd)}`;
  }

  const separator = manifest.endsWith('\n') ? '' : '\n';
  return `${manifest}${separator}\n[patch.crates-io]\n${block}\n`;
}

/// Every `[dependencies]`-style entry for a managed crate, with its raw value.
function managedDependencyEntries(manifest) {
  const found = [];
  let section = '';
  const lines = manifest.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const table = /^\[([^\]]+)\]\s*$/u.exec(line);
    if (table !== null) {
      section = table[1];
      // The table form puts one crate's keys on following lines:
      // `[dependencies.gpui]` then `git = "…"`. Rare, but legal, and skipping it
      // would leave a way past the check this function exists for.
      const tableForm = /^dependencies\.([A-Za-z0-9_-]+)$/u.exec(section);
      if (tableForm !== null && MANAGED_CRATES.includes(tableForm[1])) {
        const keys = [];
        for (let inner = index + 1; inner < lines.length; inner += 1) {
          if (/^\[/u.test(lines[inner])) break;
          keys.push(lines[inner]);
        }
        found.push({ crate: tableForm[1], value: keys.join('\n') });
      }
      continue;
    }
    if (!/(?:^|[-.])dependencies$/u.test(section)) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/u.exec(line);
    if (entry === null) continue;
    const renamed = /package\s*=\s*"([^"]+)"/u.exec(entry[2]);
    const crate = renamed === null ? entry[1] : renamed[1];
    if (!MANAGED_CRATES.includes(crate)) continue;
    found.push({ crate, value: entry[2] });
  }
  return found;
}

/**
 * Whether a version requirement accepts `version`, for the forms the ecosystem
 * actually writes. Anything else is rejected rather than guessed at, because the
 * failure mode is silent: a requirement the patch does not satisfy makes Cargo
 * print one warning and resolve the real crates.io crate instead.
 */
function versionSatisfies(requirement, version) {
  const text = requirement.trim();
  const parse = value => {
    const parts = value.split('.').map(Number);
    if (parts.some(Number.isNaN)) return undefined;
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const compare = (a, b) => {
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };
  const exact = /^=\s*(\d+(?:\.\d+){0,2})$/u.exec(text);
  if (exact !== null) return compare(parse(exact[1]), parse(version)) === 0;
  const tilde = /^~\s*(\d+(?:\.\d+){0,2})$/u.exec(text);
  if (tilde !== null) {
    const [major, minor] = parse(tilde[1]);
    const actual = parse(version);
    return (
      actual[0] === major &&
      actual[1] === minor &&
      compare(actual, [major, minor, 0]) >= 0
    );
  }
  const plain = /^\^?\s*(\d+(?:\.\d+){0,2})$/u.exec(text);
  if (plain !== null) {
    const parts = parse(plain[1]);
    const actual = parse(version);
    // Caret semantics: the leftmost non-zero component may not change.
    if (parts[0] > 0)
      return actual[0] === parts[0] && compare(actual, parts) >= 0;
    if (parts[1] > 0)
      return (
        actual[0] === 0 && actual[1] === parts[1] && compare(actual, parts) >= 0
      );
    return compare(actual, parts) === 0;
  }
  throw new Error(`unsupported version requirement "${text}"`);
}

/**
 * Reject a module crate that names a managed crate by path or git.
 *
 * `[patch]` cannot redirect a `path` dependency, and a git dependency of the
 * same repository at another rev is rejected by Cargo. Either would fail for
 * someone installing the package, a long way from the cause, so it is refused
 * here with the fix in the message. A version requirement that the patch does
 * not satisfy is worse than a failure: Cargo warns once and quietly resolves the
 * real crates.io crate, so `gpui = "0.3"` would build against Zed's gpui.
 */
export function validateModuleManifest(
  dependencyName,
  cargoPath,
  platformRoot,
) {
  const manifestPath = path.join(cargoPath, 'Cargo.toml');
  let manifest;
  try {
    manifest = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(
      `${dependencyName}: could not read ${manifestPath}: ${error.message}`,
    );
  }
  const patchedVersions = patchedCrateVersions(platformRoot);
  for (const { crate, value } of managedDependencyEntries(manifest)) {
    const expected =
      crate === 'gpui' || crate === 'gpui_platform'
        ? `{ version = "${patchedVersions[crate]}", features = [...] }`
        : `${crate} = "${CORE_CRATE_VERSION}"`;
    if (/\bpath\s*=/u.test(value) || /\bgit\s*=/u.test(value)) {
      throw new Error(
        `${dependencyName}: ${crate} must be a version requirement (e.g. ${expected}), not a path or git dependency; autolink points it at the installed @react-native-gpui/core`,
      );
    }
    // A bare form is `crate = "0.1"`, where the value is the requirement with its
    // quotes still on; an inline table is `crate = { version = "0.1" }`.
    const bare = /^"([^"]*)"$/u.exec(value.trim())?.[1];
    const requirement =
      /\bversion\s*=\s*"([^"]+)"/u.exec(value)?.[1] ?? bare ?? value;
    const version = patchedVersions[crate];
    if (!versionSatisfies(requirement, version)) {
      throw new Error(
        `${dependencyName}: ${crate} requires "${requirement}", which does not match the ${version} that autolink patches to; Cargo would resolve the crates.io crate instead`,
      );
    }
  }
}

/**
 * The version each managed crate resolves to once patched.
 *
 * Core crates are `0.1.0`. The gpui crates come from the git pin, so their
 * versions are read from the lockfile that describes that revision — the
 * numbers cannot be assumed, and `gpui`'s crates.io crate is also `0.2.2`, which
 * is exactly the collision the version check exists to catch.
 */
function patchedCrateVersions(platformRoot) {
  const versions = {};
  for (const crate of [
    'react-native-gpui',
    'rn-gpui-sys',
    'rn-gpui-module',
    'rn-gpui-module-build',
  ]) {
    versions[crate] = CORE_CRATE_VERSION;
  }
  const lockPath = path.join(platformRoot, 'ReactGpui/Cargo.lock');
  let lock;
  try {
    // Same reason as the manifest above: the pattern is line-anchored.
    lock = fs.readFileSync(lockPath, 'utf8').replace(/\r\n/gu, '\n');
  } catch (error) {
    throw new Error(`could not read ${lockPath}: ${error.message}`);
  }
  for (const crate of ['gpui', 'gpui_platform']) {
    const block = new RegExp(
      `\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"\\nsource = "git\\+https://github\\.com/streetwriters/gpui-fast[^"]*"`,
      'u',
    ).exec(lock);
    if (block === null) {
      throw new Error(
        `${lockPath} has no ${crate} from the gpui-fast git source`,
      );
    }
    versions[crate] = block[1];
  }
  return versions;
}

const cppIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const includePath = /^[A-Za-z0-9_./+-]+$/u;
const jsEngineName = /^[a-z][a-z0-9-]*$/u;
const prebuiltModes = ['auto', 'always', 'never'];

/**
 * A dependency's `platforms.desktop` entry.
 *
 * The platform used to be called `gpui`. Nothing was ever published under that
 * name, so there is no compatibility path: a dependency that still says
 * `platforms.gpui` is told so, rather than being silently skipped.
 */
function desktopPlatformFor(dependencyName, dependency) {
  const platforms = dependency.platforms ?? {};
  if (platforms.desktop) return platforms.desktop;
  if (platforms.gpui) {
    throw new Error(
      `${dependencyName}: platforms.gpui was renamed to platforms.desktop`,
    );
  }
  return undefined;
}

/**
 * The app's `project.desktop` entry.
 *
 * The same rename applies to the app as to a dependency: `project.gpui` is
 * rejected rather than read, because an option left in the old key would be
 * ignored silently and the build would quietly use the default.
 */
function desktopProjectFor(config) {
  const project = config.project ?? {};
  if (project.desktop === undefined && project.gpui !== undefined) {
    throw new Error(
      'project.gpui was renamed to project.desktop in react-native.config.js',
    );
  }
  return project.desktop;
}

/**
 * Reads the app's `project.desktop.prebuilt` option: `auto` uses the pinned
 * prebuilt C++ runtime when it matches and builds from source otherwise,
 * `always` fails the build instead of falling back, `never` builds from source.
 */
function prebuiltModeFor(project) {
  const prebuilt = project?.prebuilt ?? 'auto';
  if (!prebuiltModes.includes(prebuilt)) {
    throw new Error(
      `project.desktop.prebuilt must be one of ${prebuiltModes.map(mode => `'${mode}'`).join(', ')}`,
    );
  }
  return prebuilt;
}

/**
 * Validates a dependency's `platforms.desktop.jsEngine` entry. Installing a
 * package that declares one is how an app opts into an engine; the entry names
 * the C registration symbol core calls at startup and the optional JS tooling
 * hooks the CLI uses.
 */
function jsEngineConfigFor(dependencyName, packageRoot, jsEngine) {
  if (
    typeof jsEngine !== 'object' ||
    jsEngine === null ||
    Array.isArray(jsEngine)
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.jsEngine must be an object`,
    );
  }
  const {
    name,
    register,
    bundle,
    runtimeFiles,
    nodeApiExports,
    nodeApiLibrary,
  } = jsEngine;
  if (typeof name !== 'string' || !jsEngineName.test(name)) {
    throw new Error(
      `${dependencyName}: platforms.desktop.jsEngine.name must be a lowercase engine name (${jsEngineName})`,
    );
  }
  if (typeof register !== 'string' || !cppIdentifier.test(register)) {
    throw new Error(
      `${dependencyName}: platforms.desktop.jsEngine.register must be a C identifier`,
    );
  }
  const resolveHook = (key, value) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `${dependencyName}: platforms.desktop.jsEngine.${key} must be a path`,
      );
    }
    const resolved = path.resolve(packageRoot, value);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `${dependencyName}: platforms.desktop.jsEngine.${key} does not exist: ${resolved}`,
      );
    }
    return resolved;
  };
  // The Node-API export list is what the app's executable re-exports on Windows,
  // so the name has to be a plain library name: it becomes the DLL half of each
  // forwarded export (`napi_x = hermesvm.napi_x`).
  if (
    nodeApiExports !== undefined &&
    (typeof nodeApiLibrary !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nodeApiLibrary))
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.jsEngine.nodeApiLibrary must be a library name when nodeApiExports is set`,
    );
  }
  return {
    dependencyName,
    name,
    register,
    bundle: resolveHook('bundle', bundle),
    runtimeFiles: resolveHook('runtimeFiles', runtimeFiles),
    nodeApiExports: resolveHook('nodeApiExports', nodeApiExports),
    nodeApiLibrary: nodeApiExports === undefined ? undefined : nodeApiLibrary,
  };
}

function componentConfigFor(dependencyName, gpui) {
  const descriptors = gpui.componentDescriptors ?? [];
  const headers = gpui.componentHeaders ?? [];
  const sources = gpui.componentSources ?? [];
  const includeDirs = gpui.componentIncludeDirs ?? [];
  const sourcePackage = gpui.componentSourcePackage;
  if (
    !Array.isArray(descriptors) ||
    !descriptors.every(
      value => typeof value === 'string' && cppIdentifier.test(value),
    )
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.componentDescriptors must be an array of C++ identifiers`,
    );
  }
  if (
    !Array.isArray(headers) ||
    !headers.every(
      value =>
        typeof value === 'string' &&
        includePath.test(value) &&
        value.endsWith('.h'),
    )
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.componentHeaders must be an array of C++ header paths`,
    );
  }
  if (headers.some(value => value.split('/').includes('..'))) {
    throw new Error(
      `${dependencyName}: componentHeaders must not escape the include search path`,
    );
  }
  if (descriptors.length > 0 && headers.length === 0) {
    throw new Error(
      `${dependencyName}: componentHeaders is required when componentDescriptors are declared`,
    );
  }
  if (
    !Array.isArray(sources) ||
    !sources.every(value => typeof value === 'string')
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.componentSources must be an array of source paths`,
    );
  }
  if (
    !Array.isArray(includeDirs) ||
    !includeDirs.every(value => typeof value === 'string')
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.componentIncludeDirs must be an array of paths`,
    );
  }
  if (
    sourcePackage !== undefined &&
    (typeof sourcePackage !== 'string' ||
      !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(sourcePackage))
  ) {
    throw new Error(
      `${dependencyName}: platforms.desktop.componentSourcePackage must be a package name`,
    );
  }
  return {
    descriptors,
    headers,
    sources,
    includeDirs,
    sourcePackage,
    hostComponents: hostComponentsFor(dependencyName, gpui),
  };
}

/**
 * The host components a package registers, from
 * `platforms.desktop.hostComponents`.
 */
function hostComponentsFor(dependencyName, gpui) {
  const hostComponents = gpui.hostComponents ?? [];
  if (!Array.isArray(hostComponents)) {
    throw new Error(
      `${dependencyName}: platforms.desktop.hostComponents must be an array`,
    );
  }
  return hostComponents.map(entry => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name)
    ) {
      throw new Error(
        `${dependencyName}: each platforms.desktop.hostComponents entry needs a "name" that is a component identifier`,
      );
    }
    if (entry.measured !== undefined && typeof entry.measured !== 'boolean') {
      throw new Error(
        `${dependencyName}: hostComponents "${entry.name}" has a non-boolean "measured"`,
      );
    }
    if (
      entry.nativeSurface !== undefined &&
      typeof entry.nativeSurface !== 'boolean'
    ) {
      throw new Error(
        `${dependencyName}: hostComponents "${entry.name}" has a non-boolean "nativeSurface"`,
      );
    }
    if (entry.container !== undefined && typeof entry.container !== 'boolean') {
      throw new Error(
        `${dependencyName}: hostComponents "${entry.name}" has a non-boolean "container"`,
      );
    }
    if (entry.measured === true && entry.container === true) {
      throw new Error(
        `${dependencyName}: hostComponents "${entry.name}" cannot be both "measured" and a "container"; a measured component is a leaf, and a leaf cannot hold children`,
      );
    }
    return {
      name: entry.name,
      measured: entry.measured === true,
      nativeSurface: entry.nativeSurface === true,
      container: entry.container === true,
    };
  });
}

function generateComponentCodegen({
  appRequire,
  packageJson,
  packageRoot,
  dependencyName,
  gpui,
  generatedRoot,
  hostComponents = [],
}) {
  const componentCodegenPackage = gpui.componentCodegenPackage;
  let codegenPackageRoot = packageRoot;
  let codegenPackageJson = packageJson;
  if (componentCodegenPackage !== undefined) {
    if (
      typeof componentCodegenPackage !== 'string' ||
      !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(componentCodegenPackage)
    ) {
      throw new Error(
        `${dependencyName}: platforms.desktop.componentCodegenPackage must be a package name`,
      );
    }
    const packageJsonPath = appRequire.resolve(
      `${componentCodegenPackage}/package.json`,
    );
    codegenPackageRoot = path.dirname(packageJsonPath);
    codegenPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  }
  const codegenConfig = codegenPackageJson.codegenConfig;
  if (!codegenConfig || !['components', 'all'].includes(codegenConfig.type))
    return { sources: [], libraryName: undefined };
  const jsSrcsDir = path.resolve(
    codegenPackageRoot,
    codegenConfig.jsSrcsDir ?? '',
  );
  if (!fs.existsSync(jsSrcsDir)) {
    throw new Error(
      `${dependencyName}: Codegen source directory does not exist: ${jsSrcsDir}`,
    );
  }
  const specs = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (/\.(?:js|jsx|ts|tsx)$/u.test(entry.name)) specs.push(entryPath);
    }
  };
  visit(jsSrcsDir);
  const schema = appRequire(
    '@react-native/codegen/lib/cli/combine/combine-js-to-schema',
  ).combineSchemasInFileList(specs, 'desktop', null, codegenConfig.name);
  if (
    !Object.values(schema.modules ?? {}).some(
      module => module.type === 'Component',
    )
  )
    return { sources: [], libraryName: undefined };
  const libraryName = codegenConfig.name;
  if (
    typeof libraryName !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(libraryName)
  ) {
    throw new Error(
      `${dependencyName}: codegenConfig.name must be a C++ identifier for Fabric component codegen`,
    );
  }
  const codegenPackage = appRequire.resolve(
    '@react-native/codegen/package.json',
  );
  const codegenRoot = path.dirname(codegenPackage);
  const rnCodegen = appRequire(
    path.join(codegenRoot, 'lib/generators/RNCodegen.js'),
  );
  const outputDirectory = path.join(
    generatedRoot,
    libraryName,
    'react/renderer/components',
    libraryName,
  );
  // Generate into a staging directory and copy only what changed, as the
  // TurboModule path below does: Codegen rewrites every file, and a fresh
  // mtime on these headers reruns rn-gpui-sys's build script on every launch.
  const stagingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rn-gpui-codegen-'),
  );
  try {
    const generated = rnCodegen.generate(
      {
        libraryName,
        schema,
        outputDirectory: stagingDirectory,
        packageName: packageJson.name,
        assumeNonnull: false,
      },
      {
        generators: [
          'descriptors',
          'events',
          'props',
          'states',
          'shadow-nodes',
        ],
      },
    );
    if (generated !== true) {
      throw new Error(
        `${dependencyName}: React Native Codegen failed for Fabric components`,
      );
    }
    for (const file of findGeneratedFiles(stagingDirectory)) {
      const target = path.join(
        outputDirectory,
        path.relative(stagingDirectory, file),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeIfChanged(target, fs.readFileSync(file, 'utf8'));
    }
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
  let hostComponentLibrary;
  if (hostComponents.length > 0) {
    const specPaths = specs.filter(file =>
      /export\s+default\s+\(?codegenNativeComponent</u.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    const components = Object.fromEntries(
      hostComponents.map(component => [component.name, component]),
    );
    const { generateHostComponentCpp } = appRequire(
      '@react-native-gpui/codegen/generate-host-component-cpp',
    );
    const generatedCpp = generateHostComponentCpp({
      specPaths,
      libraryName,
      components,
    });
    writeIfChanged(
      path.join(outputDirectory, 'GpuiHostComponents.generated.cpp'),
      generatedCpp,
    );
    hostComponentLibrary = libraryName;
  }
  const sources = findCppSources(outputDirectory);
  return { sources, libraryName, hostComponentLibrary };
}

const findGeneratedFiles = directory => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findGeneratedFiles(entryPath);
    return [entryPath];
  });
};

/**
 * Generates the C++ TurboModule specs for one package: our own spec class in
 * `<libraryName>.h` and React Native's `<libraryName>JSI.h`, which carries the
 * struct helpers for named object types.
 *
 * Codegen rewrites every file it is handed, and CMake compiles the headers'
 * dependents whenever they change, so its output is staged in a temporary
 * directory and only the files whose content differs are copied over.
 */
function generateModuleCodegen({
  appRequire,
  platformRequire,
  packageJson,
  dependencyName,
  specPaths,
  generatedRoot,
  generatedLibraries,
}) {
  const libraryName = packageJson.codegenConfig?.name;
  if (typeof libraryName !== 'string' || !cppIdentifier.test(libraryName)) {
    throw new Error(
      `${dependencyName}: codegenConfig.name is required for a C++ TurboModule`,
    );
  }
  // Two packages cannot share one codegen directory: the second would overwrite
  // the first's header.
  if (generatedLibraries.has(libraryName)) {
    throw new Error(
      `${dependencyName}: codegenConfig.name ${libraryName} is already used by ${generatedLibraries.get(libraryName)}`,
    );
  }
  generatedLibraries.set(libraryName, dependencyName);
  const schema = appRequire(
    '@react-native/codegen/lib/cli/combine/combine-js-to-schema',
  ).combineSchemasInFileList(specPaths, 'desktop', null, libraryName);
  for (const name of Object.keys(schema.modules ?? {})) {
    if (schema.modules[name].type !== 'NativeModule') {
      delete schema.modules[name];
    }
  }
  const codegenPackage = appRequire.resolve(
    '@react-native/codegen/package.json',
  );
  const codegenRoot = path.dirname(codegenPackage);
  const rnCodegen = appRequire(
    path.join(codegenRoot, 'lib/generators/RNCodegen.js'),
  );
  const outputDirectory = path.join(generatedRoot, libraryName);
  const stagingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rn-gpui-codegen-'),
  );
  try {
    const generated = rnCodegen.generate(
      {
        libraryName,
        schema,
        outputDirectory: stagingDirectory,
        packageName: packageJson.name,
        assumeNonnull: false,
      },
      { generators: ['modulesCxx'] },
    );
    if (generated !== true) {
      throw new Error(
        `${dependencyName}: React Native Codegen failed for the C++ TurboModule spec`,
      );
    }
    for (const file of findGeneratedFiles(stagingDirectory)) {
      const target = path.join(
        outputDirectory,
        path.relative(stagingDirectory, file),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeIfChanged(target, fs.readFileSync(file, 'utf8'));
    }
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
  const specPathByModule = new Map(
    specPaths.map(specPath => [
      path.basename(specPath).replace(/\.[^.]+$/u, ''),
      specPath,
    ]),
  );
  const { generateCxxSpec } = platformRequire(
    '@react-native-gpui/codegen/generate-cxx-spec',
  );
  writeIfChanged(
    path.join(outputDirectory, `${libraryName}.h`),
    generateCxxSpec({
      libraryName,
      schema,
      specPaths: Object.fromEntries(specPathByModule),
    }),
  );
  return outputDirectory;
}

export function autolink({ projectRoot = process.cwd(), configFile } = {}) {
  projectRoot = path.resolve(projectRoot);
  const desktopRoot = path.join(projectRoot, 'desktop');
  const autolinkRoot = path.join(desktopRoot, 'autolink');
  const config = JSON.parse(
    configFile
      ? fs.readFileSync(path.resolve(configFile), 'utf8')
      : execFileSync(npxCommand, npxArgs(['react-native', 'config']), {
          cwd: projectRoot,
          encoding: 'utf8',
          shell: npxShell,
        }),
  );
  const prebuilt = prebuiltModeFor(desktopProjectFor(config));
  const appRequire = createRequire(path.join(projectRoot, 'package.json'));
  let platformPackageJson;
  try {
    platformPackageJson = appRequire.resolve(
      '@react-native-gpui/core/package.json',
    );
  } catch (error) {
    throw new Error(
      `could not resolve @react-native-gpui/core from ${projectRoot}: ${error.message}`,
    );
  }
  const platformRoot = fs.realpathSync(path.dirname(platformPackageJson));
  // The spec generator ships with the platform package, so resolve it from
  // there rather than from the app.
  const platformRequire = createRequire(platformPackageJson);
  const { TypeScriptParser } = appRequire(
    '@react-native/codegen/lib/parsers/typescript/parser',
  );
  const typescriptParser = new TypeScriptParser();
  const findSpecFiles = directory =>
    fs
      .readdirSync(directory)
      .filter(entry =>
        /^(?:Native.*|RN.*ModuleSpec)(?:\.d)?\.ts$/u.test(entry),
      );
  const moduleNameForSpec = specPath => {
    const schema = typescriptParser.parseFile(specPath);
    const modules = Object.values(schema.modules ?? {});
    if (modules.length !== 1 || modules[0].type !== 'NativeModule') {
      throw new Error(`${specPath} must define exactly one TurboModule`);
    }
    return modules[0].moduleName;
  };
  const runtimeCrate = path.join(platformRoot, 'ReactGpui/rn-gpui');
  if (!fs.existsSync(path.join(runtimeCrate, 'Cargo.toml'))) {
    throw new Error(
      `@react-native-gpui/core has no Rust crate at ${runtimeCrate}`,
    );
  }
  // Core owns the gpui revision; a module that copied it would drift as soon as
  // the pin moved, and the copies already had.
  const pin = gpuiPin(platformRoot);
  const rustCrates = [];
  const turboModuleSpecs = [];
  const cmakeProjects = [];
  const cppTurboModules = [];
  const appComponentDescriptors = [];
  const appComponentHeaders = [];
  const appComponentSources = [];
  const appComponentIncludeDirs = [];
  const componentNames = new Map();
  const hostComponentNames = new Map();
  const hostComponents = [];
  const hostComponentLibraries = new Set();
  const jsEngines = [];
  const codegenRoot = path.join(autolinkRoot, 'codegen');
  const generatedLibraries = new Map();
  for (const [dependencyName, dependency] of Object.entries(
    config.dependencies ?? {},
  )) {
    const root = fs.realpathSync(
      path.resolve(
        dependency.root ??
          path.join(projectRoot, 'node_modules', dependencyName),
      ),
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    const gpui = desktopPlatformFor(dependencyName, dependency);
    if (!gpui) continue;
    if (gpui.jsEngine !== undefined) {
      jsEngines.push(jsEngineConfigFor(dependencyName, root, gpui.jsEngine));
    }
    const componentConfig = componentConfigFor(dependencyName, gpui);
    const componentSourceRoot = componentConfig.sourcePackage
      ? path.dirname(
          appRequire.resolve(`${componentConfig.sourcePackage}/package.json`),
        )
      : root;
    for (const descriptor of componentConfig.descriptors) {
      const previousDependency = componentNames.get(descriptor);
      if (previousDependency) {
        throw new Error(
          `${dependencyName}: component descriptor ${descriptor} is already declared by ${previousDependency}`,
        );
      }
      componentNames.set(descriptor, dependencyName);
    }
    appComponentDescriptors.push(...componentConfig.descriptors);
    appComponentHeaders.push(...componentConfig.headers);
    for (const hostComponent of componentConfig.hostComponents) {
      const previousDependency = hostComponentNames.get(hostComponent.name);
      if (previousDependency) {
        throw new Error(
          `${dependencyName}: host component ${hostComponent.name} is already declared by ${previousDependency}`,
        );
      }
      hostComponentNames.set(hostComponent.name, dependencyName);
      hostComponents.push({
        ...hostComponent,
        index: hostComponents.length,
        dependencyName,
      });
    }
    const generatedCodegen = generateComponentCodegen({
      appRequire,
      packageJson,
      packageRoot: root,
      dependencyName,
      gpui,
      generatedRoot: codegenRoot,
      hostComponents: hostComponents.filter(
        component => component.dependencyName === dependencyName,
      ),
    });
    const declaresHostComponents =
      Array.isArray(gpui.hostComponents) && gpui.hostComponents.length > 0;
    if (
      generatedCodegen.sources.length > 0 &&
      componentConfig.descriptors.length === 0 &&
      !declaresHostComponents
    ) {
      throw new Error(
        `${dependencyName}: GPUI component Codegen is enabled, but platforms.desktop.componentDescriptors is empty`,
      );
    }
    if (generatedCodegen.hostComponentLibrary) {
      hostComponentLibraries.add(generatedCodegen.hostComponentLibrary);
    }
    appComponentSources.push(
      ...generatedCodegen.sources,
      ...componentConfig.sources.map(source =>
        path.resolve(componentSourceRoot, source),
      ),
    );
    if (generatedCodegen.sources.length > 0 && generatedCodegen.libraryName) {
      appComponentIncludeDirs.push(
        path.join(codegenRoot, generatedCodegen.libraryName),
      );
    }
    appComponentIncludeDirs.push(
      ...componentConfig.includeDirs.map(directory =>
        path.resolve(componentSourceRoot, directory),
      ),
    );
    const specDirectory =
      packageJson.codegenConfig?.jsSrcsDir ?? gpui.specs ?? 'src';
    if (gpui.cppProvider) {
      if (
        typeof gpui.cppProvider !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(gpui.cppProvider)
      ) {
        throw new Error(
          `${dependencyName}: platforms.desktop.cppProvider must be a C++ function name`,
        );
      }
      const specDir = path.join(root, specDirectory);
      const cppSpecPaths = [];
      for (const file of findSpecFiles(specDir)) {
        const specPath = path.join(specDir, file);
        const moduleName = moduleNameForSpec(specPath);
        cppSpecPaths.push(specPath);
        cppTurboModules.push({
          dependencyName,
          moduleName,
          provider: gpui.cppProvider,
          hasCmake: Boolean(gpui.cmake),
          sources: gpui.cppSources
            ? gpui.cppSources.map(source => path.resolve(root, source))
            : gpui.cmake
              ? findCppSources(path.resolve(root, gpui.cmake))
              : [],
        });
        turboModuleSpecs.push(specPath);
      }
      if (cppSpecPaths.length > 0) {
        const moduleCodegenDirectory = generateModuleCodegen({
          appRequire,
          platformRequire,
          packageJson,
          dependencyName,
          specPaths: cppSpecPaths,
          generatedRoot: codegenRoot,
          generatedLibraries,
        });
        appComponentIncludeDirs.push(moduleCodegenDirectory);
        for (const entry of cppTurboModules) {
          if (
            entry.dependencyName === dependencyName &&
            entry.specs === undefined
          ) {
            entry.specs = cppSpecPaths;
            entry.headers = findGeneratedFiles(moduleCodegenDirectory).filter(
              file => file.endsWith('.h'),
            );
          }
        }
      }
    }
    if (!gpui.crate) {
      if (gpui.cmake) cmakeProjects.push(path.resolve(root, gpui.cmake));
      continue;
    }
    const crateName = gpui.crate;
    if (typeof crateName !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(crateName)) {
      throw new Error(
        `${dependencyName}: platforms.desktop.crate must be a Cargo crate name`,
      );
    }
    if (
      !gpui.path &&
      !fs.existsSync(path.join(root, 'desktop/Cargo.toml')) &&
      fs.existsSync(path.join(root, 'gpui/Cargo.toml'))
    ) {
      throw new Error(
        `${dependencyName}: the gpui/ folder was renamed to desktop/`,
      );
    }
    const defaultCargoPath = fs.existsSync(
      path.join(root, 'desktop/Cargo.toml'),
    )
      ? 'desktop'
      : '.';
    const cargoPath = path.resolve(root, gpui.path ?? defaultCargoPath);
    if (!fs.existsSync(path.join(cargoPath, 'Cargo.toml'))) {
      throw new Error(`${dependencyName}: no Cargo.toml at ${cargoPath}`);
    }
    const alias = crateName.replaceAll('-', '_');
    const moduleTypes = [];
    const specDir = path.join(root, specDirectory);
    if (fs.existsSync(specDir)) {
      for (const file of findSpecFiles(specDir)) {
        const specPath = path.join(specDir, file);
        const moduleName = moduleNameForSpec(specPath);
        moduleTypes.push(moduleName);
        turboModuleSpecs.push(specPath);
      }
    }
    validateModuleManifest(dependencyName, cargoPath, platformRoot);
    rustCrates.push({
      dependencyName,
      packageName: packageJson.name,
      crateName,
      alias,
      cargoPath,
      moduleTypes,
    });
    if (gpui.cmake) cmakeProjects.push(path.resolve(root, gpui.cmake));
  }

  // Node addons are loaded from the stock `.node` files a package ships, at
  // the absolute path the Babel plugin embeds (see
  // @react-native-gpui/core/babel-plugin-node-addons.js). Nothing is staged here any
  // more, but an app directory from an earlier run may still hold the old
  // staging tree, so remove it.
  fs.rmSync(path.join(autolinkRoot, 'node-api'), {
    recursive: true,
    force: true,
  });

  const localDesktopSource = path.join(projectRoot, 'desktop/src');
  if (fs.existsSync(localDesktopSource)) {
    for (const file of findSpecFiles(localDesktopSource)) {
      const specPath = path.join(localDesktopSource, file);
      moduleNameForSpec(specPath);
      turboModuleSpecs.push(specPath);
    }
  }

  const engineNames = new Map();
  for (const engine of jsEngines) {
    const previousDependency = engineNames.get(engine.name);
    if (previousDependency) {
      throw new Error(
        `${engine.dependencyName}: JS engine '${engine.name}' is already declared by ${previousDependency}`,
      );
    }
    engineNames.set(engine.name, engine.dependencyName);
  }
  if (jsEngines.length === 0) {
    throw new Error(
      'no JS engine installed; add @react-native-gpui/hermes (or another engine package) to the app dependencies',
    );
  }

  const generatedDir = autolinkRoot;
  fs.mkdirSync(generatedDir, { recursive: true });
  const manifest = {
    prebuilt,
    rustCrates,
    turboModuleSpecs,
    cppTurboModules,
    cmakeProjects,
    appComponentDescriptors,
    hostComponents,
    appComponentHeaders: [...new Set(appComponentHeaders)],
    appComponentSources: [...new Set(appComponentSources)],
    appComponentIncludeDirs: [...new Set(appComponentIncludeDirs)],
    jsEngines,
  };
  writeIfChanged(
    path.join(generatedDir, 'autolink.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const autolinkCrate = generatedDir;
  fs.mkdirSync(path.join(autolinkCrate, 'src'), { recursive: true });
  const generatedDeps = rustCrates
    .map(({ alias, crateName, cargoPath }) => {
      const relativePath = path
        .relative(autolinkCrate, cargoPath)
        .split(path.sep)
        .join('/');
      return `${alias} = { package = ${escapeToml(crateName)}, path = ${escapeToml(relativePath)} }`;
    })
    .join('\n');
  writeIfChanged(
    path.join(autolinkCrate, 'Cargo.toml'),
    `[package]\nname = "rn-gpui-autolink"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nreact-native-gpui = { path = ${escapeToml(
      path.relative(autolinkCrate, runtimeCrate).split(path.sep).join('/'),
    )} }\n${generatedDeps}`,
  );
  const ensureLinked = rustCrates.map(
    ({ alias }) => `    ${alias}::rn_gpui_register();`,
  );
  const generatedEnsureLinked = [
    'pub fn ensure_linked() {',
    '    unsafe {',
    '        rn_gpui_initialize_app_turbo_modules();',
    '    }',
    '    declare_host_components();',
    ...ensureLinked,
    '    ensure_host_components();',
    '}',
  ].join('\n');
  const hostComponentDeclarations = hostComponents
    .map(
      ({ index, name, measured, nativeSurface, container }) =>
        `    react_native_gpui::host_component::declare_host_component(${index}, ${JSON.stringify(name)}, react_native_gpui::host_component::HostComponentOptions { measured: ${measured}, native_surface: ${nativeSurface}, container: ${container} });`,
    )
    .join('\n');
  const hostComponentChecks = hostComponents
    .map(
      ({ index, name }) =>
        `    expect_host_component(${index}, ${JSON.stringify(name)});`,
    )
    .join('\n');
  const generatedEnsureHostComponents = [
    'fn declare_host_components() {',
    hostComponentDeclarations || '    // No package declares a host component.',
    '}',
    '',
    'fn expect_host_component(index: u32, name: &str) {',
    '    assert!(',
    '        react_native_gpui::host_component::is_registered(index),',
    '        "{name}: declared under platforms.desktop.hostComponents but no rn_gpui_register() registered it; call react_native_gpui::host_component::register_component from the crate that owns the component.",',
    '    );',
    '}',
    '',
    'pub fn ensure_host_components() {',
    hostComponentChecks || '    // No package declares a host component.',
    '}',
  ].join('\n');
  writeIfChanged(
    path.join(autolinkCrate, 'src/lib.rs'),
    `// Generated by @react-native-gpui/cli autolink; do not edit.\nextern "C" {\n    fn rn_gpui_initialize_app_turbo_modules();\n}\n${generatedEnsureLinked}\n\n${generatedEnsureHostComponents}\n`,
  );

  const appCargoManifest = path.join(desktopRoot, 'Cargo.toml');
  if (!fs.existsSync(appCargoManifest)) {
    throw new Error(`missing desktop Cargo manifest: ${appCargoManifest}`);
  }
  let appCargo = fs.readFileSync(appCargoManifest, 'utf8');
  const runtimeCrateRelativePath = path
    .relative(desktopRoot, runtimeCrate)
    .split(path.sep)
    .join('/');
  const runtimeCrateTomlPath = escapeToml(runtimeCrateRelativePath);
  const runtimeDependencyPattern = /^(react-native-gpui\s*=\s*)\{([^\n]*)\}$/mu;
  if (runtimeDependencyPattern.test(appCargo)) {
    appCargo = appCargo.replace(
      runtimeDependencyPattern,
      (_line, prefix, properties) => {
        const withoutOldPath = properties
          .replace(/(?:^|,)\s*path\s*=\s*"[^"]*"\s*/gu, '')
          .trim()
          .replace(/^,\s*|\s*,\s*$/gu, '');
        return `${prefix}{ path = ${runtimeCrateTomlPath}${withoutOldPath ? `, ${withoutOldPath}` : ''} }`;
      },
    );
  } else {
    appCargo = appCargo.replace(
      /^\[dependencies\]\s*$/mu,
      section =>
        `${section}\nreact-native-gpui = { path = ${runtimeCrateTomlPath} }`,
    );
  }
  if (!/^react-native-gpui\s*=/mu.test(appCargo)) {
    throw new Error(`could not add react-native-gpui to ${appCargoManifest}`);
  }
  if (!/^rn-gpui-autolink\s*=/mu.test(appCargo)) {
    appCargo = appCargo.replace(
      /^\[dependencies\]\s*$/mu,
      section => `${section}\nrn-gpui-autolink = { path = "autolink" }`,
    );
    if (!/^rn-gpui-autolink\s*=/mu.test(appCargo)) {
      appCargo += `\n[dependencies]\nrn-gpui-autolink = { path = "autolink" }\n`;
    }
  }
  // The app's own Rust TurboModules: its build script generates the glue, and
  // main.rs registers the modules it declares.
  const moduleCrate = path
    .relative(
      desktopRoot,
      path.join(path.dirname(runtimeCrate), 'rn-gpui-module'),
    )
    .split(path.sep)
    .join('/');
  const moduleBuildCrate = path
    .relative(
      desktopRoot,
      path.join(path.dirname(runtimeCrate), 'rn-gpui-module-build'),
    )
    .split(path.sep)
    .join('/');
  const moduleDependency = `rn-gpui-module = { path = ${escapeToml(moduleCrate)} }`;
  if (!/^rn-gpui-module\s*=/mu.test(appCargo)) {
    appCargo = appCargo.replace(
      /^\[dependencies\]\s*$/mu,
      section => `${section}\n${moduleDependency}`,
    );
  }
  const moduleBuildDependency = `rn-gpui-module-build = { path = ${escapeToml(moduleBuildCrate)} }`;
  if (!/^rn-gpui-module-build\s*=/mu.test(appCargo)) {
    if (/^\[build-dependencies\]\s*$/mu.test(appCargo)) {
      appCargo = appCargo.replace(
        /^\[build-dependencies\]\s*$/mu,
        section => `${section}\n${moduleBuildDependency}`,
      );
    } else {
      appCargo += `\n[build-dependencies]\n${moduleBuildDependency}\n`;
    }
  }
  if (!/^\[features\]\s*$/mu.test(appCargo)) {
    appCargo = appCargo.replace(
      /^\[dependencies\]\s*$/mu,
      '[features]\nvisual-capture = ["react-native-gpui/visual-capture"]\ntest-driver = ["react-native-gpui/test-driver"]\n\n[dependencies]',
    );
  } else {
    const tableStart = appCargo.indexOf('[features]');
    const suffixStart = appCargo.indexOf(
      '\n[',
      tableStart + '[features]'.length,
    );
    const tableEnd = suffixStart < 0 ? appCargo.length : suffixStart;
    let featureLines = appCargo.slice(
      tableStart + '[features]'.length,
      tableEnd,
    );
    if (!/^visual-capture\s*=/mu.test(featureLines))
      featureLines += '\nvisual-capture = ["react-native-gpui/visual-capture"]';
    if (!/^test-driver\s*=/mu.test(featureLines))
      featureLines += '\ntest-driver = ["react-native-gpui/test-driver"]';
    appCargo = `${appCargo.slice(0, tableStart)}[features]${featureLines}${appCargo.slice(tableEnd)}`;
  }
  // `[patch]` is only honoured in the root manifest, so the redirection lives in
  // the app's rather than in each module crate.
  appCargo = applyPatchBlock(
    appCargo,
    appCargoManifest,
    managedPatchEntries(platformRoot, desktopRoot),
  );
  writeIfChanged(appCargoManifest, appCargo);
  const appMain = path.join(desktopRoot, 'src/main.rs');
  if (fs.existsSync(appMain)) {
    let source = fs.readFileSync(appMain, 'utf8');
    if (!source.includes('rn_gpui_autolink::ensure_linked()')) {
      if (!/fn main\s*\(\s*\)\s*\{/u.test(source)) {
        throw new Error(
          `${appMain} must define fn main() for GPUI autolinking`,
        );
      }
      source = source.replace(
        /(fn main\s*\(\s*\)\s*\{)/u,
        '$1\n    rn_gpui_autolink::ensure_linked();',
      );
      writeIfChanged(appMain, source);
    }
  }
  const cppProviderPath = path.join(
    generatedDir,
    'CppTurboModules.generated.cpp',
  );
  const cppProviderCases = cppTurboModules
    .map(
      ({ moduleName, provider }) =>
        `  if (name == ${JSON.stringify(moduleName)}) return ::${provider}(name, jsInvoker);`,
    )
    .join('\n');
  const hostComponentRegistrationDeclarations = [...hostComponentLibraries]
    .map(
      library =>
        `extern "C" void rn_gpui_register_host_components_${library}();`,
    )
    .join('\n');
  const hostComponentRegistrationCalls = [...hostComponentLibraries]
    .map(library => `  rn_gpui_register_host_components_${library}();`)
    .join('\n');
  const componentHeaders = [...new Set(appComponentHeaders)]
    .map(header => `#include <${header}>`)
    .join('\n');
  const componentRegistration = appComponentDescriptors
    .map(
      descriptor =>
        `  addComponent(facebook::react::concreteComponentDescriptorProvider<facebook::react::${descriptor}>());`,
    )
    .join('\n');
  writeIfChanged(
    cppProviderPath,
    `// Generated by @react-native-gpui/cli autolink; do not edit.\n#include <ReactCommon/TurboModule.h>\n#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>\n#include <iostream>\n#include <memory>\n#include <string>\n#include <unordered_set>\n${componentHeaders}\n${hostComponentRegistrationDeclarations}\n${[...new Set(cppTurboModules.map(({ provider }) => `extern std::shared_ptr<facebook::react::TurboModule> ${provider}(const std::string&, std::shared_ptr<facebook::react::CallInvoker>);`))].join('\n')}\nextern "C" void rn_gpui_set_app_cpp_turbo_module_provider(std::shared_ptr<facebook::react::TurboModule> (*)(const std::string&, std::shared_ptr<facebook::react::CallInvoker>));\nextern "C" void rn_gpui_initialize_app_turbo_modules() {\n${hostComponentRegistrationCalls}\n  rn_gpui_set_app_cpp_turbo_module_provider(+[](const std::string& name, std::shared_ptr<facebook::react::CallInvoker> jsInvoker) -> std::shared_ptr<facebook::react::TurboModule> {\n${cppProviderCases}\n    return nullptr;\n  });\n}\nnamespace rngpui {\nvoid rn_gpui_register_app_components(facebook::react::ComponentDescriptorProviderRegistry& registry) {\n  static const std::unordered_set<std::string> builtins = {"View", "Paragraph", "Text", "RawText", "Image", "ScrollView", "TextInput", "ModalHostView", "NativeViewHost"};\n  std::unordered_set<std::string> registered;\n  auto addComponent = [&registry, &registered](const facebook::react::ComponentDescriptorProvider& provider) {\n    const std::string name(provider.name);\n    if (builtins.contains(name) || !registered.insert(name).second) {\n      std::cerr << "[rn-gpui] duplicate app Fabric component descriptor ignored: " << name << std::endl;\n      return;\n    }\n    registry.add(provider);\n  };\n${componentRegistration}\n}\n} // namespace rngpui\n`,
  );
  const cppSources = [
    ...new Set([
      ...cppTurboModules
        .filter(({ hasCmake }) => !hasCmake)
        .flatMap(({ sources }) => sources),
      ...appComponentSources,
    ]),
  ];
  const cmakePath = value => value.replaceAll('\\', '/').replaceAll('"', '\\"');
  const cmake = [
    ...cmakeProjects.map(
      (directory, index) =>
        `add_subdirectory("${cmakePath(directory)}" "${cmakePath(path.join('${CMAKE_BINARY_DIR}', `rn_gpui_autolink_${index}`))}")`,
    ),
    `set(RN_GPUI_APP_CPP_PROVIDER_SOURCE "${cmakePath(cppProviderPath)}")`,
    `set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES ${cppSources.map(source => `"${cmakePath(source)}"`).join(' ')})`,
    `set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS ${appComponentIncludeDirs.map(directory => `"${cmakePath(directory)}"`).join(' ')})`,
    // Core calls each registration symbol from the generated
    // rn_gpui_install_modules(), so the engine registry is populated before
    // the host selects an engine.
    ...jsEngines.map(
      engine =>
        `set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_REGISTRATIONS "${engine.register}")`,
    ),
  ].join('\n');
  writeIfChanged(
    path.join(generatedDir, 'autolink.cmake'),
    `# Generated by @react-native-gpui/cli autolink.\n${cmake}\n`,
  );
  console.log(
    `Autolinked ${rustCrates.length} GPUI Rust crate(s), ${cppTurboModules.length} C++ TurboModule(s), ${cmakeProjects.length} CMake project(s), and ${jsEngines.length} JS engine(s) [${jsEngines.map(({ name }) => name).join(', ')}].`,
  );
  return config;
}
