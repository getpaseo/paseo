import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { generateHostComponentCpp } from './generate-host-component-cpp.js';
import { generateRustSpec } from './generate-rust-spec.js';
import { KITCHEN_SINK_SPEC } from './kitchen-sink-spec.js';

const FLAGS = {
  index: 0,
  measured: false,
  container: false,
  nativeSurface: false,
};

const writeSpec = (name, source) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'host-component-cpp-'),
  );
  const file = path.join(directory, `${name}NativeComponent.ts`);
  fs.writeFileSync(file, source);
  return file;
};

const specFile = writeSpec('FixtureChart', KITCHEN_SINK_SPEC);

const cpp = generateHostComponentCpp({
  specPaths: [specFile],
  libraryName: 'KitchenSinkSpec',
  components: { FixtureChart: FLAGS },
});
const rust = generateRustSpec({ specPaths: [specFile] });

/// The names of the `extern "C"` shims the generated Rust declares.
const declaredShims = () => {
  const block = rust.slice(rust.lastIndexOf('unsafe extern "C" {'));
  return [...block.matchAll(/^\s+fn (rn_gpui_\w+)\(/gmu)].map(
    match => match[1],
  );
};

describe('the C++ half implements the shims the Rust half declares', () => {
  test('every declared shim has a definition of the same name', () => {
    const shims = declaredShims();
    expect(shims.length).toBeGreaterThan(20);
    const missing = shims.filter(
      shim => !new RegExp(`\\b${shim}\\(`, 'u').test(cpp),
    );
    expect(
      missing.filter(shim => !shim.startsWith('rn_gpui_image_source_')),
    ).toEqual([]);
  });

  test('no shim is defined that Rust does not declare', () => {
    const declared = new Set(declaredShims());
    const defined = [...cpp.matchAll(/^\S.*\b(rn_gpui_\w+)\(/gmu)].map(
      match => match[1],
    );
    expect(
      defined.filter(
        shim =>
          !declared.has(shim) &&
          !shim.startsWith('rn_gpui_register_host_components_'),
      ),
    ).toEqual([]);
  });

  test('the Rust half has no shim for the change mask: C++ computes it', () => {
    expect(rust).not.toContain('fn rn_gpui_fixture_chart_changed(');
    expect(cpp).toContain('void fixture_chart_changed(');
  });
});

describe('the generated file registers the component with core', () => {
  test('carries its index, flags and entry points', () => {
    const declared = generateHostComponentCpp({
      specPaths: [specFile],
      libraryName: 'KitchenSinkSpec',
      components: {
        FixtureChart: {
          index: 7,
          measured: false,
          container: true,
          nativeSurface: true,
        },
      },
    });
    expect(declared).toContain('entry.index = 7;');
    expect(declared).toContain('entry.container = true;');
    expect(declared).toContain('entry.nativeSurface = true;');
    expect(declared).toContain('entry.measured = false;');
    expect(declared).toContain('entry.changeWords = 1;');
    expect(declared).toContain(
      'extern "C" void rn_gpui_register_host_components_KitchenSinkSpec() {',
    );
  });

  test("instantiates core's templates over the types React Native generated", () => {
    expect(cpp).toContain(
      'rngpui::GpuiHostLeafShadowNode<kFixtureChartName, rr::FixtureChartProps, rr::FixtureChartEventEmitter, false>',
    );
    expect(cpp).toContain(
      'rr::ConcreteComponentDescriptor<FixtureChartShadowNode>',
    );
    expect(cpp).toContain(
      'entry.provider = &rr::concreteComponentDescriptorProvider<FixtureChartDescriptor>;',
    );
  });

  test('a measured component is a measured leaf, a container uses its own descriptor', () => {
    const measured = generateHostComponentCpp({
      specPaths: [specFile],
      libraryName: 'KitchenSinkSpec',
      components: { FixtureChart: { ...FLAGS, measured: true } },
    });
    expect(measured).toContain('rr::FixtureChartEventEmitter, true>');
    const container = generateHostComponentCpp({
      specPaths: [specFile],
      libraryName: 'KitchenSinkSpec',
      components: { FixtureChart: { ...FLAGS, container: true } },
    });
    expect(container).toContain(
      'rngpui::GpuiHostContainerShadowNode<kFixtureChartName, rr::FixtureChartProps, rr::FixtureChartEventEmitter>',
    );
    expect(container).toContain(
      'rngpui::GpuiHostContainerDescriptor<FixtureChartShadowNode>',
    );
  });
});

describe('the change mask', () => {
  test('sets one bit per changed prop, in the order the Rust mask names them', () => {
    expect(cpp).toContain('words[0] |= uint64_t{1} << 0;');
    expect(cpp).toContain('words[0] |= uint64_t{1} << 14;');
  });

  test('compares cheap fields before arrays and dynamic values', () => {
    const body = cpp.slice(cpp.indexOf('void fixture_chart_changed('));
    const scalar = body.indexOf('before.lineWidth == after.lineWidth');
    const array = body.indexOf('rn_eq_vec(before.points');
    const dynamic = body.indexOf('before.extra == after.extra');
    expect(scalar).toBeGreaterThan(-1);
    expect(array).toBeGreaterThan(scalar);
    expect(dynamic).toBeGreaterThan(array);
  });

  test('compares a struct field by field, never by memcmp over padding', () => {
    expect(cpp).not.toContain('memcmp');
    expect(cpp).toContain('bool eq_FixtureChartPoints(');
  });

  test('spans a word per 64 props', () => {
    const props = Array.from(
      { length: 130 },
      (_, index) => `  prop${index}?: Int32;`,
    );
    const file = writeSpec(
      'Many',
      `import { codegenNativeComponent, type ViewProps } from 'react-native';
export interface NativeProps extends ViewProps {
${props.join('\n')}
}
export default codegenNativeComponent<NativeProps>('Many', { interfaceOnly: true });
`,
    );
    const many = generateHostComponentCpp({
      specPaths: [file],
      libraryName: 'ManySpec',
      components: { Many: FLAGS },
    });
    expect(many).toContain('entry.changeWords = 3;');
    expect(many).toContain('words[2] |= uint64_t{1} << 1;');
  });
});

describe('commands and events', () => {
  test('validate arguments against the spec and dispatch by index', () => {
    expect(cpp).toContain('bool fixture_chart_command(');
    expect(cpp).toContain('if (command == "selectPoint")');
    expect(cpp).toContain(
      'rngpui::dispatchHostCommand(tag, 0, std::move(values));',
    );
    expect(cpp).toContain(
      'rngpui::dispatchHostCommand(tag, 1, std::move(values));',
    );
    expect(cpp).toContain(
      'rngpui::dispatchHostCommand(tag, 2, std::move(values));',
    );
    expect(cpp).toContain('.isNumber()');
    expect(cpp).toContain('rn_numbers(args[0])');
    expect(cpp).toContain('.isString()');
    expect(cpp).toContain(
      "FixtureChart.selectPoint: argument 'index' must be a number",
    );
  });

  test('fill the generated event struct from the flattened leaves', () => {
    expect(cpp).toContain(
      'rr::FixtureChartEventEmitter::OnPointSelected value{};',
    );
    expect(cpp).toContain('value.index = index;');
    expect(cpp).toContain('.onPointSelected(std::move(value));');
    expect(cpp).toContain('value.nested.flag = nested_flag;');
    expect(cpp).toContain('value.nested.names.emplace_back(');
    expect(cpp).toContain(
      'void rn_gpui_fixture_chart_event_done(const void* emitter) {',
    );
  });
});

describe('the generator rejects a component core cannot host', () => {
  test('one that is not declared under hostComponents', () => {
    expect(() =>
      generateHostComponentCpp({
        specPaths: [specFile],
        libraryName: 'KitchenSinkSpec',
        components: {},
      }),
    ).toThrow(
      /FixtureChart is not declared under platforms\.desktop\.hostComponents/u,
    );
  });

  test('one that is not interfaceOnly: React Native would generate a second descriptor', () => {
    const file = writeSpec(
      'Plain',
      KITCHEN_SINK_SPEC.replace(
        /\{\s*interfaceOnly: true,?\s*\}/u,
        '{ paperComponentName: "FixtureChart" }',
      ),
    );
    expect(() =>
      generateHostComponentCpp({
        specPaths: [file],
        libraryName: 'KitchenSinkSpec',
        components: { FixtureChart: FLAGS },
      }),
    ).toThrow(
      /must be created with codegenNativeComponent\(\.\.\., \{ interfaceOnly: true \}\)/u,
    );
  });

  test('one that is both measured and a container', () => {
    expect(() =>
      generateHostComponentCpp({
        specPaths: [specFile],
        libraryName: 'KitchenSinkSpec',
        components: {
          FixtureChart: { ...FLAGS, measured: true, container: true },
        },
      }),
    ).toThrow(/cannot be both measured and a container/u);
  });
});

/// The compile flags of core's own C++, from a CMake tree that was built here.
/// Absent on a machine that never built the app, where the compile test skips.
const buildTree = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../target/rn-gpui-cmake/aarch64-apple-darwin/Debug/build',
);
const flagsFile = path.join(
  buildTree,
  'CMakeFiles/rn_gpui_core.dir/flags.make',
);
const canCompile = fs.existsSync(flagsFile) && fs.existsSync('/usr/bin/c++');

const flag = name => {
  const line = fs
    .readFileSync(flagsFile, 'utf8')
    .split('\n')
    .find(candidate => candidate.startsWith(`${name} =`));
  return line === undefined ? '' : line.slice(name.length + 3);
};

/// The newest cxx bridge header cargo generated, which declares the shared
/// structs core's headers include.
const bridgeInclude = () => {
  const builds = path.resolve(buildTree, '../../../../debug/build');
  const candidates = fs
    .readdirSync(builds)
    .filter(entry => entry.startsWith('rn-gpui-sys-'))
    .map(entry => path.join(builds, entry, 'out/cxxbridge/include'))
    .filter(directory =>
      fs.existsSync(path.join(directory, 'rn-gpui-sys/src/lib.rs.h')),
    )
    .sort(
      (left, right) =>
        fs.statSync(path.join(right, 'rn-gpui-sys/src/lib.rs.h')).mtimeMs -
        fs.statSync(path.join(left, 'rn-gpui-sys/src/lib.rs.h')).mtimeMs,
    );
  return candidates[0];
};

describe.skipIf(!canCompile)(
  'the generated file compiles against the real headers',
  () => {
    const root = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../..',
    );

    /// Generates React Native's own `Props.h` and `EventEmitters.h` for `file`
    /// into a fresh include tree, and returns the include directory.
    const reactNativeHeaders = (file, libraryName) => {
      const require = createRequire(path.join(root, 'package.json'));
      const schema =
        require('@react-native/codegen/lib/cli/combine/combine-js-to-schema').combineSchemasInFileList(
          [file],
          'desktop',
          null,
          libraryName,
        );
      const include = fs.mkdtempSync(
        path.join(os.tmpdir(), 'host-component-include-'),
      );
      const staging = fs.mkdtempSync(
        path.join(os.tmpdir(), 'host-component-rn-'),
      );
      const generated =
        require('@react-native/codegen/lib/generators/RNCodegen.js').generate(
          {
            libraryName,
            schema,
            outputDirectory: staging,
            packageName: 'test',
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
      expect(generated).toBe(true);
      const target = path.join(
        include,
        'react/renderer/components',
        libraryName,
      );
      fs.mkdirSync(target, { recursive: true });
      for (const header of ['Props.h', 'EventEmitters.h']) {
        fs.copyFileSync(path.join(staging, header), path.join(target, header));
      }
      return include;
    };

    const compile = (source, include) => {
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'host-component-cc-')),
        'generated.cpp',
      );
      fs.writeFileSync(file, source);
      const bridge = bridgeInclude();
      const command = [
        '/usr/bin/c++',
        flag('CXX_DEFINES'),
        flag('CXX_FLAGS'),
        `-I${include}`,
        `-I${bridge}`,
        `-I${path.join(bridge, '../crate')}`,
        flag('CXX_INCLUDES'),
        '-fsyntax-only',
        file,
      ].join(' ');
      return spawnSync('/bin/sh', ['-c', command], {
        cwd: buildTree,
        encoding: 'utf8',
      });
    };

    test('every layout, offset and enum value matches the real types', () => {
      const include = reactNativeHeaders(specFile, 'KitchenSinkSpec');
      const result = compile(cpp, include);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }, 120_000);

    test('a wrong layout breaks the build instead of corrupting a prop', () => {
      const include = reactNativeHeaders(specFile, 'KitchenSinkSpec');
      const broken = cpp.replace(
        'offsetof(rr::FixtureChartPointsStruct, y) == 8',
        'offsetof(rr::FixtureChartPointsStruct, y) == 16',
      );
      expect(broken).not.toBe(cpp);
      const result = compile(broken, include);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('static assertion failed');
    }, 120_000);

    test('a measured leaf, a container and a 130 prop component compile too', () => {
      const include = reactNativeHeaders(specFile, 'KitchenSinkSpec');
      for (const flags of [
        { ...FLAGS, measured: true },
        { ...FLAGS, container: true, nativeSurface: true },
      ]) {
        const source = generateHostComponentCpp({
          specPaths: [specFile],
          libraryName: 'KitchenSinkSpec',
          components: { FixtureChart: flags },
        });
        const result = compile(source, include);
        expect(result.stderr).toBe('');
      }

      const props = Array.from(
        { length: 130 },
        (_, index) => `  prop${index}?: Int32;`,
      );
      const many = writeSpec(
        'Many',
        `import { codegenNativeComponent, type ViewProps } from 'react-native';
export interface NativeProps extends ViewProps {
${props.join('\n')}
}
export default codegenNativeComponent<NativeProps>('Many', { interfaceOnly: true });
`,
      );
      const manyInclude = reactNativeHeaders(many, 'ManySpec');
      const result = compile(
        generateHostComponentCpp({
          specPaths: [many],
          libraryName: 'ManySpec',
          components: { Many: FLAGS },
        }),
        manyInclude,
      );
      expect(result.stderr).toBe('');
    }, 240_000);
  },
);
