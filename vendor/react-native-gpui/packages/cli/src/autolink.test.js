import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import {
  applyPatchBlock,
  autolink,
  gpuiKitPatchNames,
  manifestDependencyNames,
  specFilesFor,
} from './autolink.js';

// The repository root by lookup, not by counting parents: this file sits at a
// different depth before and after a folder move.
const repoRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces)
          return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('no workspace root above the test');
    dir = parent;
  }
})();
const temporaryRoots = [];

const spec = `import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  greet(name: string): string;
  loadLater(name: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Fake');
`;

/**
 * A project small enough for autolink to run end to end: a manifest to resolve
 * from, a desktop Cargo manifest, one JS engine, and one C++ TurboModule
 * package. It lives under the repo so Node resolves the workspace packages.
 */
function createProject({
  withCodegenConfig = true,
  duplicateLibrary = false,
  project,
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(repoRoot, '.local/autolink-'));
  temporaryRoots.push(projectRoot);
  const write = (relative, contents) => {
    const target = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write(
    'package.json',
    `${JSON.stringify({ name: 'autolink-test-app', version: '0.0.1' }, null, 2)}\n`,
  );
  write(
    'desktop/Cargo.toml',
    '[package]\nname = "autolink-test-app"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\n',
  );
  write(
    'node_modules/fake-engine/package.json',
    `${JSON.stringify({ name: 'fake-engine', version: '0.0.1' }, null, 2)}\n`,
  );
  const moduleManifest = {
    name: 'fake-module',
    version: '0.0.1',
    ...(withCodegenConfig
      ? {
          codegenConfig: {
            name: 'FakeSpec',
            type: 'modules',
            jsSrcsDir: 'src',
          },
        }
      : {}),
  };
  write(
    'node_modules/fake-module/package.json',
    `${JSON.stringify(moduleManifest, null, 2)}\n`,
  );
  write('node_modules/fake-module/src/NativeFake.ts', spec);
  write(
    'node_modules/fake-module/desktop/CMakeLists.txt',
    'set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES "${CMAKE_CURRENT_LIST_DIR}/cpp/FakeModule.cpp")\n',
  );
  write('node_modules/fake-module/cpp/FakeModule.cpp', '// fake module\n');
  write(
    'node_modules/fake-module/react-native.config.js',
    "module.exports = {dependency: {platforms: {desktop: {cmake: 'desktop', cppProvider: 'create_fake_module'}}}};\n",
  );
  if (duplicateLibrary) {
    write(
      'node_modules/fake-module-two/package.json',
      `${JSON.stringify(
        {
          name: 'fake-module-two',
          version: '0.0.1',
          codegenConfig: {
            name: 'FakeSpec',
            type: 'modules',
            jsSrcsDir: 'src',
          },
        },
        null,
        2,
      )}\n`,
    );
    write('node_modules/fake-module-two/src/NativeFakeTwo.ts', spec);
    write(
      'node_modules/fake-module-two/react-native.config.js',
      "module.exports = {dependency: {platforms: {desktop: {cppProvider: 'create_fake_two_module'}}}};\n",
    );
  }
  const configPath = path.join(projectRoot, 'rn-config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...(project ? { project: { desktop: project } } : {}),
        dependencies: {
          'fake-engine': {
            root: path.join(projectRoot, 'node_modules/fake-engine'),
            platforms: {
              desktop: {
                jsEngine: {
                  name: 'hermes',
                  register: 'rn_gpui_register_js_engine_hermes',
                },
              },
            },
          },
          'fake-module': {
            root: path.join(projectRoot, 'node_modules/fake-module'),
            platforms: {
              desktop: { cmake: 'desktop', cppProvider: 'create_fake_module' },
            },
          },
          ...(duplicateLibrary
            ? {
                'fake-module-two': {
                  root: path.join(projectRoot, 'node_modules/fake-module-two'),
                  platforms: {
                    desktop: { cppProvider: 'create_fake_two_module' },
                  },
                },
              }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { projectRoot, configPath };
}

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generates both spec headers for a C++ TurboModule package', () => {
  const { projectRoot, configPath } = createProject();
  autolink({ projectRoot, configFile: configPath });
  const codegenDirectory = path.join(
    projectRoot,
    'desktop/autolink/codegen/FakeSpec',
  );
  const ours = fs.readFileSync(
    path.join(codegenDirectory, 'FakeSpec.h'),
    'utf8',
  );
  const reactNative = fs.readFileSync(
    path.join(codegenDirectory, 'FakeSpecJSI.h'),
    'utf8',
  );
  expect(ours).toContain('#include <FakeSpecJSI.h>');
  expect(ours).toContain(
    'class NativeFakeSpec : public rngpui::TurboModuleBase<T>',
  );
  expect(ours).toContain('kModuleName = "Fake"');
  expect(ours).toContain('this->template valueMethod<&T::greet>("greet");');
  expect(ours).toContain(
    'this->template promiseMethod<&T::loadLater>("loadLater");',
  );
  expect(reactNative).toContain('NativeFakeCxxSpec');
  expect(reactNative).toContain('"Fake"');
  const cmake = fs.readFileSync(
    path.join(projectRoot, 'desktop/autolink/autolink.cmake'),
    'utf8',
  );
  const includeDirs = cmake
    .split('\n')
    .find(line => line.includes('RN_GPUI_APP_CPP_INCLUDE_DIRS'));
  // The generated CMake normalises every path to `/`, which is what CMake
  // accepts on every platform (a Windows `\` is an escape in a CMake string).
  expect(includeDirs).toContain(codegenDirectory.replaceAll('\\', '/'));
});

const manifestOf = projectRoot =>
  JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, 'desktop/autolink/autolink.json'),
      'utf8',
    ),
  );

test('writes the prebuilt mode into the manifest, defaulting to auto', () => {
  const defaults = createProject();
  autolink({
    projectRoot: defaults.projectRoot,
    configFile: defaults.configPath,
  });
  expect(manifestOf(defaults.projectRoot).prebuilt).toBe('auto');

  const always = createProject({ project: { prebuilt: 'always' } });
  autolink({ projectRoot: always.projectRoot, configFile: always.configPath });
  expect(manifestOf(always.projectRoot).prebuilt).toBe('always');
});

test('throws on an unknown prebuilt mode', () => {
  const { projectRoot, configPath } = createProject({
    project: { prebuilt: true },
  });
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    "project.desktop.prebuilt must be one of 'auto', 'always', 'never'",
  );
});

test('reads project.desktop without complaint', () => {
  const { projectRoot, configPath } = createProject({
    project: { prebuilt: 'never' },
  });
  autolink({ projectRoot, configFile: configPath });
  expect(manifestOf(projectRoot).prebuilt).toBe('never');
});

test('throws when a C++ TurboModule package has no codegenConfig.name', () => {
  const { projectRoot, configPath } = createProject({
    withCodegenConfig: false,
  });
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    'fake-module: codegenConfig.name is required for a C++ TurboModule',
  );
});

test('throws when two packages share one codegenConfig.name', () => {
  const { projectRoot, configPath } = createProject({ duplicateLibrary: true });
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    'fake-module-two: codegenConfig.name FakeSpec is already used by fake-module',
  );
});

test('leaves both headers untouched when nothing changed', () => {
  const { projectRoot, configPath } = createProject();
  autolink({ projectRoot, configFile: configPath });
  const codegenDirectory = path.join(
    projectRoot,
    'desktop/autolink/codegen/FakeSpec',
  );
  const headers = ['FakeSpec.h', 'FakeSpecJSI.h'].map(name =>
    path.join(codegenDirectory, name),
  );
  const before = headers.map(header => fs.statSync(header).mtimeMs);
  autolink({ projectRoot, configFile: configPath });
  const after = headers.map(header => fs.statSync(header).mtimeMs);
  expect(after).toEqual(before);
});

test('registers a crate that has no TurboModule specs', () => {
  const { projectRoot, configPath } = createProject();
  const crateRoot = path.join(projectRoot, 'node_modules/fake-paint');
  fs.mkdirSync(path.join(crateRoot, 'desktop/src'), { recursive: true });
  fs.writeFileSync(
    path.join(crateRoot, 'package.json'),
    `${JSON.stringify({ name: 'fake-paint', version: '0.0.1' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(crateRoot, 'desktop/Cargo.toml'),
    '[package]\nname = "fake-paint"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\n',
  );
  fs.writeFileSync(
    path.join(crateRoot, 'react-native.config.js'),
    "module.exports = {dependency: {platforms: {desktop: {crate: 'fake-paint'}}}};\n",
  );
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.dependencies['fake-paint'] = {
    root: crateRoot,
    platforms: { desktop: { crate: 'fake-paint' } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  autolink({ projectRoot, configFile: configPath });
  const generated = fs.readFileSync(
    path.join(projectRoot, 'desktop/autolink/src/lib.rs'),
    'utf8',
  );
  expect(generated).toContain('fake_paint::rn_gpui_register();');
});

test('hands desktop.json to the app so its window options need no main.rs change', () => {
  const { projectRoot, configPath } = createProject();
  fs.writeFileSync(
    path.join(projectRoot, 'desktop/desktop.json'),
    JSON.stringify({
      window: { titleBar: 'hidden', trafficLightPosition: { x: 10, y: 14 } },
    }),
  );
  autolink({ projectRoot, configFile: configPath });
  const generated = fs.readFileSync(
    path.join(projectRoot, 'desktop/autolink/src/lib.rs'),
    'utf8',
  );
  expect(generated).toContain(
    'react_native_gpui::set_desktop_defaults(DESKTOP_JSON);',
  );
  expect(generated).toContain('"titleBar":"hidden"');
  expect(generated).toContain('"trafficLightPosition":{"x":10,"y":14}');
});

/**
 * A project with one Rust module crate, so the manifest checks have something to
 * read. The crate's manifest is the argument: the tests below vary only that.
 */
function projectWithRustCrate(manifest) {
  // No codegen config: `fake-module` declares a `cppProvider`, and a C++
  // TurboModule without a `codegenConfig.name` is refused before the manifest
  // checks this fixture is about would run.
  const { projectRoot, configPath } = createProject({
    withCodegenConfig: false,
  });
  const config0 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete config0.dependencies['fake-module'];
  fs.writeFileSync(configPath, `${JSON.stringify(config0, null, 2)}\n`);
  const crateRoot = path.join(projectRoot, 'node_modules/fake-rust');
  fs.mkdirSync(path.join(crateRoot, 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(crateRoot, 'package.json'),
    `${JSON.stringify({ name: 'fake-rust', version: '0.0.1' }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(crateRoot, 'desktop/Cargo.toml'), manifest);
  fs.writeFileSync(
    path.join(crateRoot, 'react-native.config.js'),
    "module.exports = {dependency: {platforms: {desktop: {crate: 'fake-rust'}}}};\n",
  );
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.dependencies['fake-rust'] = {
    root: crateRoot,
    platforms: { desktop: { crate: 'fake-rust' } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { projectRoot, configPath, crateRoot };
}

const CARGO_HEADER =
  '[package]\nname = "fake-rust"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\n';

test('the app manifest gets a managed patch block pointing at core', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const appCargo = fs.readFileSync(
    path.join(projectRoot, 'desktop/Cargo.toml'),
    'utf8',
  );
  expect(appCargo).toContain('[patch.crates-io]');
  expect(appCargo).toContain(
    '# Managed by @react-native-gpui/cli autolink; do not edit between these markers.',
  );
  expect(appCargo).toMatch(
    /^rn-gpui-module = \{ path = "[^"]+rn-gpui-module" \}$/mu,
  );
  expect(appCargo).toMatch(
    /^react-native-gpui = \{ path = "[^"]+rn-gpui" \}$/mu,
  );
  // The rev must be core's, read from core's own manifest, not a copy.
  const coreManifest = fs.readFileSync(
    path.join(repoRoot, 'packages/core/ReactGpui/Cargo.toml'),
    'utf8',
  );
  const rev = /^gpui = \{[^}]*rev = "([^"]+)"/mu.exec(coreManifest)?.[1];
  expect(rev).toBeDefined();
  expect(appCargo).toContain(
    `gpui = { git = "https://github.com/streetwriters/gpui-fast", rev = "${rev}" }`,
  );
});

test('the app manifest gets the module crates in their own sections', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  const appManifest = path.join(projectRoot, 'desktop/Cargo.toml');
  fs.writeFileSync(
    appManifest,
    '[package]\nname = "app"\nversion = "0.0.1"\nedition = "2021"\n\n[build-dependencies]\nserde_json = "1"\n\n[dependencies]\n',
  );
  autolink({ projectRoot, configFile: configPath });
  autolink({ projectRoot, configFile: configPath });
  const appCargo = fs.readFileSync(appManifest, 'utf8');
  const dependencies = appCargo.slice(
    appCargo.indexOf('[dependencies]'),
    appCargo.indexOf('[patch.crates-io]'),
  );
  const buildDependencies = appCargo.slice(
    appCargo.indexOf('[build-dependencies]'),
    appCargo.indexOf('[features]'),
  );
  expect(dependencies).toMatch(/^rn-gpui-module = \{ path = "[^"]+" \}$/mu);
  expect(buildDependencies).toMatch(
    /^rn-gpui-module-build = \{ path = "[^"]+" \}$/mu,
  );
  expect(appCargo.match(/^rn-gpui-module = /gmu)).toHaveLength(2);
});

test('a path to a crate of core through a symlink becomes the real path', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  const appManifest = path.join(projectRoot, 'desktop/Cargo.toml');
  fs.writeFileSync(
    appManifest,
    '[package]\nname = "app"\nversion = "0.0.1"\nedition = "2021"\n\n[build-dependencies]\nrn-gpui-module-build = { path = "../node_modules/core/rn-gpui-module-build" }\n\n[dependencies]\nrn-gpui-module = { path = "../node_modules/core/rn-gpui-module" }\n',
  );
  autolink({ projectRoot, configFile: configPath });
  const appCargo = fs.readFileSync(appManifest, 'utf8');
  expect(appCargo).not.toContain('node_modules/core');
  expect(appCargo).toMatch(
    /^rn-gpui-module = \{ path = "[^"]+ReactGpui\/rn-gpui-module" \}$/gmu,
  );
});

test('a second autolink leaves the app manifest byte-identical', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const manifest = path.join(projectRoot, 'desktop/Cargo.toml');
  const once = fs.readFileSync(manifest, 'utf8');
  autolink({ projectRoot, configFile: configPath });
  expect(fs.readFileSync(manifest, 'utf8')).toBe(once);
});

test('an unrelated user patch table is kept, with one header', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  const manifest = path.join(projectRoot, 'desktop/Cargo.toml');
  const original = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(
    manifest,
    `${original}\n[patch.crates-io]\nserde = { path = "vendor/serde" }\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const patched = fs.readFileSync(manifest, 'utf8');
  expect(patched).toContain('serde = { path = "vendor/serde" }');
  expect(patched.match(/^\[patch\.crates-io\]$/gmu)).toHaveLength(1);
  expect(patched).toContain('rn-gpui-module = { path =');
});

test('a user patch table that claims a managed key is refused', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  const manifest = path.join(projectRoot, 'desktop/Cargo.toml');
  const original = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(
    manifest,
    `${original}\n[patch.crates-io]\ngpui = { path = "my-gpui" }\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /already sets gpui/u,
  );
});

test('a module crate may not name core by path', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = { path = "../../core/ReactGpui/rn-gpui-module" }\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /must be a version requirement/u,
  );
});

test('a module crate may not pin gpui by git', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\ngpui = { git = "https://github.com/streetwriters/gpui-fast", rev = "c380367" }\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /must be a version requirement/u,
  );
});

test('a gpui requirement the patch does not satisfy is refused', () => {
  // 0.3 would resolve to the crates.io crate instead, and the only sign would be
  // one warning Cargo prints and nobody reads.
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\ngpui = "0.3"\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /does not match the 0\.2\.2/u,
  );
});

test('a managed crate in table form is checked too', () => {
  // `[dependencies.gpui]` with its keys on the following lines is legal TOML, so
  // it must not be a way past the path check.
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n\n[dependencies.gpui]\ngit = "https://github.com/streetwriters/gpui-fast"\nrev = "c380367"\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /must be a version requirement/u,
  );
});

test('a CRLF lockfile still yields the managed block', () => {
  // A Windows checkout with core.autocrlf gives these files CRLF endings. The
  // lockfile pattern anchors on `\n`, so without normalising the read it finds no
  // gpui entry and autolink throws on every Windows run. The manifest pattern
  // survives CRLF on its own, because `\s*$` treats `\r` as whitespace.
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  const coreLock = path.join(repoRoot, 'packages/core/ReactGpui/Cargo.lock');
  const original = fs.readFileSync(coreLock, 'utf8');
  fs.writeFileSync(coreLock, original.replace(/\n/gu, '\r\n'));
  try {
    autolink({ projectRoot, configFile: configPath });
    const rev = /^gpui = \{[^}]*rev = "([^"]+)"/mu.exec(
      fs.readFileSync(
        path.join(repoRoot, 'packages/core/ReactGpui/Cargo.toml'),
        'utf8',
      ),
    )?.[1];
    expect(
      fs.readFileSync(path.join(projectRoot, 'desktop/Cargo.toml'), 'utf8'),
    ).toContain(`rev = "${rev}"`);
  } finally {
    fs.writeFileSync(coreLock, original);
  }
});

/**
 * Adds a package that declares host components: a codegen spec for each, a Rust
 * crate, and `hostComponents` entries in the platform config.
 */
function addHostComponentPackage(
  { projectRoot, configPath },
  {
    name = 'fake-host',
    library = 'FakeHostSpec',
    components,
    interfaceOnly = true,
  },
) {
  const root = path.join(projectRoot, 'node_modules', name);
  const write = (relative, contents) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write(
    'package.json',
    `${JSON.stringify(
      {
        name,
        version: '0.0.1',
        codegenConfig: { name: library, type: 'components', jsSrcsDir: 'src' },
      },
      null,
      2,
    )}\n`,
  );
  write(
    'desktop/Cargo.toml',
    `[package]\nname = "${name}"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\n`,
  );
  for (const component of components) {
    write(
      `src/${component.name}NativeComponent.ts`,
      `import { codegenNativeComponent, type ViewProps } from 'react-native';

export interface NativeProps extends ViewProps {
  title?: string;
  count?: Int32;
}

export default codegenNativeComponent<NativeProps>('${component.name}'${
        interfaceOnly ? ', { interfaceOnly: true }' : ''
      });
`,
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.dependencies[name] = {
    root,
    platforms: {
      desktop: {
        crate: name,
        hostComponents: components,
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

const generatedLib = projectRoot =>
  fs.readFileSync(
    path.join(projectRoot, 'desktop/autolink/src/lib.rs'),
    'utf8',
  );

const generatedProvider = projectRoot =>
  fs.readFileSync(
    path.join(projectRoot, 'desktop/autolink/CppTurboModules.generated.cpp'),
    'utf8',
  );

test('declares each host component with its index and layout flags', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    components: [
      { name: 'FakeChart' },
      { name: 'FakeLabel', measured: true },
      { name: 'FakeCard', container: true, nativeSurface: true },
    ],
  });
  autolink({
    projectRoot: project.projectRoot,
    configFile: project.configPath,
  });
  const lib = generatedLib(project.projectRoot);
  expect(lib).toContain(
    'declare_host_component(0, "FakeChart", react_native_gpui::host_component::HostComponentOptions { measured: false, native_surface: false, container: false, cpp: false, mask_children: false });',
  );
  expect(lib).toContain(
    'declare_host_component(1, "FakeLabel", react_native_gpui::host_component::HostComponentOptions { measured: true, native_surface: false, container: false, cpp: false, mask_children: false });',
  );
  expect(lib).toContain(
    'declare_host_component(2, "FakeCard", react_native_gpui::host_component::HostComponentOptions { measured: false, native_surface: true, container: true, cpp: false, mask_children: false });',
  );
  // Declared before any package registers, then checked for code afterwards.
  expect(lib.indexOf('declare_host_components();')).toBeLessThan(
    lib.indexOf('fake_host::rn_gpui_register();'),
  );
  expect(lib.indexOf('fake_host::rn_gpui_register();')).toBeLessThan(
    lib.indexOf('ensure_host_components();'),
  );
  expect(lib).toContain('expect_host_component(2, "FakeCard");');
});

test('generates the C++ that registers a host component library and calls it at startup', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    components: [{ name: 'FakeChart' }, { name: 'FakeCard', container: true }],
  });
  autolink({
    projectRoot: project.projectRoot,
    configFile: project.configPath,
  });
  const generated = path.join(
    project.projectRoot,
    'desktop/autolink/codegen/FakeHostSpec/react/renderer/components/FakeHostSpec/GpuiHostComponents.generated.cpp',
  );
  const cpp = fs.readFileSync(generated, 'utf8');
  expect(cpp).toContain('entry.index = 0;');
  expect(cpp).toContain('entry.index = 1;');
  expect(cpp).toContain('entry.container = true;');
  expect(cpp).toContain(
    'extern "C" void rn_gpui_register_host_components_FakeHostSpec() {',
  );
  // The app calls it explicitly: a static library member nothing references is
  // dropped by the linker, and its static initialiser with it.
  const provider = generatedProvider(project.projectRoot);
  expect(provider).toContain(
    'extern "C" void rn_gpui_register_host_components_FakeHostSpec();',
  );
  expect(provider).toContain(
    '  rn_gpui_register_host_components_FakeHostSpec();',
  );
  // The generated file is compiled with React Native's own output for the spec.
  const cmake = fs.readFileSync(
    path.join(project.projectRoot, 'desktop/autolink/autolink.cmake'),
    'utf8',
  );
  expect(cmake).toContain('GpuiHostComponents.generated.cpp');
  expect(cmake).toContain('Props.cpp');
});

test('numbers host components across packages in one global order', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    name: 'fake-host',
    library: 'FakeHostSpec',
    components: [{ name: 'FakeChart' }],
  });
  addHostComponentPackage(project, {
    name: 'fake-host-two',
    library: 'FakeHostTwoSpec',
    components: [{ name: 'FakeOther' }],
  });
  autolink({
    projectRoot: project.projectRoot,
    configFile: project.configPath,
  });
  const lib = generatedLib(project.projectRoot);
  expect(lib).toContain('declare_host_component(0, "FakeChart"');
  expect(lib).toContain('declare_host_component(1, "FakeOther"');
});

test('refuses a host component that is both measured and a container', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    components: [{ name: 'FakeBoth', measured: true, container: true }],
  });
  expect(() =>
    autolink({
      projectRoot: project.projectRoot,
      configFile: project.configPath,
    }),
  ).toThrow(/cannot be both "measured" and a "container"/u);
});

test('refuses a host component whose spec is not interfaceOnly', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    interfaceOnly: false,
    components: [{ name: 'FakeChart' }],
  });
  expect(() =>
    autolink({
      projectRoot: project.projectRoot,
      configFile: project.configPath,
    }),
  ).toThrow(
    /must be created with codegenNativeComponent\(\.\.\., \{ interfaceOnly: true \}\)/u,
  );
});

test('refuses a duplicate host component name across packages', () => {
  const project = createProject();
  addHostComponentPackage(project, {
    name: 'fake-host',
    library: 'FakeHostSpec',
    components: [{ name: 'FakeChart' }],
  });
  addHostComponentPackage(project, {
    name: 'fake-host-two',
    library: 'FakeHostTwoSpec',
    components: [{ name: 'FakeChart' }],
  });
  expect(() =>
    autolink({
      projectRoot: project.projectRoot,
      configFile: project.configPath,
    }),
  ).toThrow(/host component FakeChart is already declared by fake-host/u);
});

test('splits the specifications of a package between its C++ provider and its crate', () => {
  const files = ['NativeCrypto.ts', 'NativeSubtle.ts'];
  expect(specFilesFor(files, undefined, 'cpp')).toEqual(files);
  expect(specFilesFor(files, undefined, 'rust')).toEqual(files);
  expect(specFilesFor(files, ['NativeCrypto.ts'], 'cpp')).toEqual([
    'NativeCrypto.ts',
  ]);
  expect(specFilesFor(files, ['NativeCrypto.ts'], 'rust')).toEqual([
    'NativeSubtle.ts',
  ]);
  expect(() => specFilesFor(files, ['NativeMissing.ts'], 'cpp')).toThrow(
    /NativeMissing.ts/u,
  );
  expect(() => specFilesFor(files, 'NativeCrypto.ts', 'cpp')).toThrow(/array/u);
});

const coreRev = () => {
  const coreManifest = fs.readFileSync(
    path.join(repoRoot, 'packages/core/ReactGpui/Cargo.toml'),
    'utf8',
  );
  return /^gpui = \{[^}]*rev = "([^"]+)"/mu.exec(coreManifest)?.[1];
};

const KIT_NAMES = ['gpui-pre', 'gpui-pre-macros', 'gpui-pre-sum-tree'];

test('a module crate that depends on GPUI Kit gets the gpui-pre crates patched to the pin of core', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\ngpui-component = "=0.9.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const appCargo = fs.readFileSync(
    path.join(projectRoot, 'desktop/Cargo.toml'),
    'utf8',
  );
  const block = appCargo.slice(
    appCargo.indexOf('# Managed by'),
    appCargo.indexOf('# End managed'),
  );
  for (const name of KIT_NAMES) {
    expect(block).toContain(
      `${name} = { git = "https://github.com/streetwriters/gpui-fast", rev = "${coreRev()}" }`,
    );
  }
  expect(block).not.toContain('gpui-pre-platform');
  expect(block).not.toContain('gpui-pre-web');
  expect(block).not.toContain('gpui-pre-reqwest-client');
});

test('an app without a GPUI Kit module gets no gpui-pre patches', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const appCargo = fs.readFileSync(
    path.join(projectRoot, 'desktop/Cargo.toml'),
    'utf8',
  );
  expect(appCargo).not.toContain('gpui-pre');
});

test('the gpui-pre patches follow the modules: they go when the kit does', () => {
  const { projectRoot, configPath, crateRoot } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\ngpui-base = "=0.9.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const manifest = path.join(projectRoot, 'desktop/Cargo.toml');
  expect(fs.readFileSync(manifest, 'utf8')).toContain('gpui-pre-macros');
  fs.writeFileSync(
    path.join(crateRoot, 'desktop/Cargo.toml'),
    `${CARGO_HEADER}rn-gpui-module = "0.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  expect(fs.readFileSync(manifest, 'utf8')).not.toContain('gpui-pre');
});

test('a hand-written gpui-pre line beside the managed block is refused with the fix', () => {
  const { projectRoot, configPath } = projectWithRustCrate(
    `${CARGO_HEADER}rn-gpui-module = "0.1"\ngpui-component = "=0.9.1"\n`,
  );
  autolink({ projectRoot, configFile: configPath });
  const manifest = path.join(projectRoot, 'desktop/Cargo.toml');
  fs.writeFileSync(
    manifest,
    `${fs.readFileSync(manifest, 'utf8')}gpui-pre = { git = "https://github.com/streetwriters/gpui-fast", rev = "abc" }\n`,
  );
  expect(() => autolink({ projectRoot, configFile: configPath })).toThrow(
    /already sets gpui-pre, which autolink owns; remove that line/u,
  );
});

test('the optional gpui-pre crates are patched when a module names them or the lockfile has them', () => {
  expect(
    gpuiKitPatchNames([
      '[dependencies]\ngpui-component = "=0.9.1"\ngpui-pre-web = "0.3"\n',
    ]),
  ).toEqual([...KIT_NAMES, 'gpui-pre-web']);
  expect(
    gpuiKitPatchNames(
      ['[dependencies]\ngpui-component = "=0.9.1"\n'],
      '[[package]]\nname = "gpui-pre-platform"\nversion = "0.3.12"\n',
    ),
  ).toEqual([...KIT_NAMES, 'gpui-pre-platform']);
  expect(gpuiKitPatchNames(['[dependencies]\nserde = "1"\n'])).toEqual([]);
});

test('GPUI Kit is found by dependency name in any section and under a rename', () => {
  expect(
    manifestDependencyNames(
      '[dependencies]\na = "1"\nkit = { package = "gpui-component", version = "1" }\n[target.\'cfg(unix)\'.dependencies]\nb = "1"\n[build-dependencies]\nc = "1"\n[dependencies.gpui-kit-assets]\nversion = "1"\n[dependencies.other]\npackage = "gpui-base"\n[features]\nd = []\n',
    ),
  ).toEqual(['a', 'gpui-component', 'b', 'c', 'gpui-kit-assets', 'gpui-base']);
  expect(
    gpuiKitPatchNames(['[dependencies.other]\npackage = "gpui-base"\n']),
  ).toEqual(KIT_NAMES);
});

test('entries added to the managed block are refused if the user table sets them', () => {
  const manifest =
    '[package]\nname = "a"\n\n[patch.crates-io]\nfoo = { path = "x" }\n';
  expect(() =>
    applyPatchBlock(manifest, 'Cargo.toml', [['foo', '{ path = "y" }']]),
  ).toThrow(/already sets foo/u);
});
