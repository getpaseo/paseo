const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { activeJsEngineBundle } = require('./js-engine');

const PACKAGE_NAME = '@react-native-gpui/core';
const PACKAGE_DIR = __dirname;
const ENTRY = path.join(PACKAGE_DIR, 'index.desktop.js');
const SETUP_ENV = path.join(PACKAGE_DIR, 'setup-env.js');
const SRC_DIR = path.join(PACKAGE_DIR, 'src-gpui');
const DESKTOP_SUFFIX = /\.desktop\.(?:js|ts|tsx)$/;
// Some React Native modules ship only `.ios.js`/`.android.js`; desktop uses iOS's.
const FALLBACK_PLATFORM = 'ios';

const isInside = (file, dir) => file.startsWith(dir + path.sep);
const withFilePath = (resolution, filePath) => ({ ...resolution, filePath });

// "<package>/<path in package>" for a file under node_modules, so an override
// applies to every installed copy of the package.
function packageKey(filePath) {
  const parts = filePath.split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  return index === -1 ? null : parts.slice(index + 1).join('/');
}

// The nearest repository or workspace root above `directory`, or null.
function findTreeRoot(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    try {
      const manifest = path.join(current, 'package.json');
      if (JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces) {
        return current;
      }
    } catch {}
    if (path.dirname(current) === current) return null;
  }
}

// Every node_modules from `directory` up to its tree root (only its own when
// there is no root), never above it.
function nodeModulesUpToTreeRoot(directory) {
  const stop = findTreeRoot(directory) ?? directory;
  const found = [];
  for (let current = directory; ; current = path.dirname(current)) {
    const modules = path.join(current, 'node_modules');
    if (fs.existsSync(modules)) found.push(modules);
    if (current === stop || path.dirname(current) === current) return found;
  }
}

// `src-gpui/<path>.desktop.js` replaces React Native's `<path>.js` (and its
// platform variants).
function reactNativeOverrides(reactNativeDir) {
  const overrides = new Map();
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      if (!DESKTOP_SUFFIX.test(entry.name)) continue;
      const base = path
        .relative(SRC_DIR, file)
        .replace(DESKTOP_SUFFIX, '')
        .split(path.sep)
        .join('/');
      for (const variant of ['.js', '.native.js', '.ios.js', '.android.js']) {
        if (fs.existsSync(path.join(reactNativeDir, base + variant))) {
          overrides.set(`react-native/${base}${variant}`, file);
        }
      }
    }
  };
  walk(SRC_DIR);
  return overrides;
}

// A library package declares its replacements in react-native.config.js as
// `platforms.desktop.sourceOverrides: { '<package>/<file>': './<own file>' }`.
function libraryOverrides(packageDirs) {
  const overrides = new Map();
  for (const packageDir of packageDirs) {
    const configFile = path.join(packageDir, 'react-native.config.js');
    if (!fs.existsSync(configFile)) continue;
    const declared =
      require(configFile).dependency?.platforms?.desktop?.sourceOverrides ?? {};
    for (const [key, target] of Object.entries(declared)) {
      overrides.set(key, path.resolve(packageDir, target));
    }
  }
  return overrides;
}

// React Native's `Foo.js` deep-import shims re-export `./Foo` and expect a
// platform variant to win, which never happens for gpui.
const SHIM =
  /^(?:import ([\w$]+) from '\.\/\1'; ?export default \1;?|export \* from '\.\/[\w$]+';?)$/;
const shims = new Map();
function isReExportShim(filePath) {
  if (!shims.has(filePath)) {
    const code = fs
      .readFileSync(filePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    shims.set(filePath, SHIM.test(code));
  }
  return shims.get(filePath);
}

function makeMetroConfig({ projectRoot = process.cwd() } = {}) {
  const appRequire = createRequire(path.join(projectRoot, 'package.json'));
  const reactNativeEntry = appRequire.resolve('react-native');
  const reactNativeDir = path.dirname(reactNativeEntry);
  const appPackage = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  const nodeModulesPaths = nodeModulesUpToTreeRoot(projectRoot);
  const dependencyDirs = Object.keys({
    ...appPackage.dependencies,
    ...appPackage.devDependencies,
  }).flatMap(name => {
    const modules = nodeModulesPaths.find(dir =>
      fs.existsSync(path.join(dir, name)),
    );
    return modules ? [fs.realpathSync(path.join(modules, name))] : [];
  });
  // Linked packages (`file:`, workspaces) resolve their imports from the tree
  // they live in, so Metro has to watch that tree's node_modules too.
  const linkedDirs = dependencyDirs.filter(
    dir =>
      !isInside(dir, projectRoot) &&
      !nodeModulesPaths.some(modules => isInside(dir, modules)),
  );
  const watchFolders = [
    ...new Set([
      PACKAGE_DIR,
      reactNativeDir,
      ...nodeModulesPaths,
      ...linkedDirs.flatMap(dir => [dir, ...nodeModulesUpToTreeRoot(dir)]),
    ]),
  ].filter((folder, _, all) => !all.some(other => isInside(folder, other)));

  const rnOverrides = reactNativeOverrides(reactNativeDir);
  const rnOverrideFiles = new Set(rnOverrides.values());
  const overrides = new Map([
    ...rnOverrides,
    ...libraryOverrides(dependencyDirs),
  ]);

  const resolveWithFallback = (context, moduleName, platform) => {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch (error) {
      try {
        return context.resolveRequest(context, moduleName, FALLBACK_PLATFORM);
      } catch {
        throw error;
      }
    }
  };

  const resolveModule = (context, moduleName, platform) => {
    const origin = context.originModulePath ?? '';
    // Every route to RN's setup-env goes through ours first (it adds `window`).
    if (
      moduleName === 'react-native/setup-env' ||
      (moduleName === '../../src/setup-env' &&
        /[\\/]Libraries[\\/]Core[\\/]InitializeCore\.js$/.test(origin))
    ) {
      const target =
        origin === SETUP_ENV
          ? path.join(reactNativeDir, 'src/setup-env.js')
          : SETUP_ENV;
      return resolveWithFallback(context, target, platform);
    }
    // An override keeps the relative imports of the file it replaces.
    if (moduleName.startsWith('.') && rnOverrideFiles.has(origin)) {
      const upstream = path
        .relative(SRC_DIR, origin)
        .replace(DESKTOP_SUFFIX, '.js');
      context = {
        ...context,
        originModulePath: path.join(reactNativeDir, upstream),
      };
    }
    // `react-native` means this package, except inside this package.
    if (moduleName === 'react-native' || moduleName === PACKAGE_NAME) {
      const target = isInside(origin, PACKAGE_DIR) ? reactNativeEntry : ENTRY;
      return resolveWithFallback(context, target, platform);
    }
    // `@react-native-gpui/core/<file>` is this package's file, else RN's.
    if (moduleName.startsWith(`${PACKAGE_NAME}/`)) {
      const subpath = moduleName.slice(PACKAGE_NAME.length + 1);
      try {
        return context.resolveRequest(
          context,
          path.join(PACKAGE_DIR, subpath),
          platform,
        );
      } catch {
        return resolveWithFallback(
          context,
          `react-native/${subpath}`,
          platform,
        );
      }
    }
    return resolveWithFallback(context, moduleName, platform);
  };

  const resolveRequest = (context, moduleName, platform) => {
    let resolution = resolveModule(context, moduleName, platform);
    // An adapter in src-gpui can import an explicit upstream variant.
    if (
      isInside(context.originModulePath ?? '', SRC_DIR) &&
      /\.(?:ios|android)(?:\.js)?$/.test(moduleName)
    ) {
      return resolution;
    }
    let key = resolution?.filePath && packageKey(resolution.filePath);
    if (key?.startsWith('react-native/') && key.endsWith('.js')) {
      const variant = resolution.filePath.replace(
        /\.js$/,
        `.${FALLBACK_PLATFORM}.js`,
      );
      if (fs.existsSync(variant) && isReExportShim(resolution.filePath)) {
        resolution = withFilePath(resolution, variant);
        key = packageKey(variant);
      }
    }
    const override = key && overrides.get(key);
    return override ? withFilePath(resolution, override) : resolution;
  };

  const config = mergeConfig(getDefaultConfig(projectRoot), {
    watchFolders,
    // Leaves `Platform.OS` to the runtime: Metro would fold it to `desktop`.
    transformerPath: path.join(PACKAGE_DIR, 'metro-transform-worker.js'),
    serializer: {
      // Ours, not RN's: the default names the RN beside @react-native/metro-config,
      // which is not in the app's graph when this package is linked.
      getModulesRunBeforeMainModule: () => [SETUP_ENV],
    },
    resolver: {
      platforms: ['desktop', 'native'],
      nodeModulesPaths,
      // Resolve only from `nodeModulesPaths`, not by walking up from each
      // importing file. When this package is linked (`file:`, `npm link`, a
      // workspace), its own sources import `react`/`react-native`, and that walk
      // finds the *linked tree's* copies — a second React in the app's bundle,
      // which React rejects with "Invalid hook call" as soon as a component runs.
      // `nodeModulesPaths` already lists every `node_modules` from the app up to
      // its tree root, so nothing legitimate is lost; the tester has set this at
      // its own config for the same reason.
      disableHierarchicalLookup: true,
      // `main` over `browser`: a desktop app wants native bindings, not WASM.
      resolverMainFields: ['react-native', 'main'],
      resolveRequest,
    },
  });

  // The active JS engine can adjust the config (e.g. its bytecode transform).
  const engineBundle = activeJsEngineBundle(projectRoot);
  return typeof engineBundle?.metroConfig === 'function'
    ? mergeConfig(config, engineBundle.metroConfig(config) ?? {})
    : config;
}

module.exports = { makeMetroConfig, findTreeRoot, nodeModulesUpToTreeRoot };
