import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { generateCxxSpec } from './generate-cxx-spec.js';

const require = createRequire(import.meta.url);

const spec = `import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  greet(name: string): string;
  record(value: string): void;
  greetLater(name: string): Promise<string>;
  lookup(key: string, callback: (value: string, found: boolean) => void): void;
  readonly onProgress: CodegenTypes.EventEmitter<number>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Probe');
`;

/** Runs the real TS parser over `source` and returns the generated header. */
function generateFor(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-gpui-spec-'));
  const specPath = path.join(directory, 'NativeProbe.ts');
  fs.writeFileSync(specPath, source);
  const {
    combineSchemasInFileList,
  } = require('@react-native/codegen/lib/cli/combine/combine-js-to-schema');
  const schema = combineSchemasInFileList(
    [specPath],
    'desktop',
    null,
    'ProbeSpec',
  );
  return generateCxxSpec({
    libraryName: 'ProbeSpec',
    schema,
    specPaths: { NativeProbe: specPath },
  });
}

test('generates a spec class per module with one registration per method', () => {
  const header = generateFor(spec);
  expect(header).toContain('#include "GpuiTurboModule.h"');
  expect(header).toContain('#include <ProbeSpecJSI.h>');
  expect(header).toContain(
    'class NativeProbeSpec : public rngpui::TurboModuleBase<T>',
  );
  expect(header).toContain(
    'static constexpr std::string_view kModuleName = "Probe";',
  );
  expect(header).toContain('this->template valueMethod<&T::greet>("greet");');
  expect(header).toContain('this->template voidMethod<&T::record>("record");');
  expect(header).toContain(
    'this->template promiseMethod<&T::greetLater>("greetLater");',
  );
});

test('asserts the parameter count with the expected signature in words', () => {
  const header = generateFor(spec);
  expect(header).toContain(
    '"greet must be declared as std::string greet(jsi::Runtime& rt, std::string name)"',
  );
  expect(header).toContain(
    '"record must be declared as void record(std::string value); with kThread = JS it takes jsi::Runtime& rt first"',
  );
  expect(header).toContain(
    '"greetLater must be declared as void greetLater(std::string name, rngpui::Promise<std::string>); with kThread = JS it takes jsi::Runtime& rt first"',
  );
  expect(header).toContain(
    'getParameterCount(&T::greet) ==\n            1 + 1,',
  );
  expect(header).toContain(
    'getParameterCount(&T::greetLater) ==\n            (T::kThread == rngpui::ModuleThread::JS ? 1 : 0) + 1 + 1,',
  );
});

test('converts a callback parameter to rngpui::Callback', () => {
  const header = generateFor(spec);
  expect(header).toContain('rngpui::Callback<std::string, bool> callback');
  expect(header).toContain(
    'void lookup(std::string key, rngpui::Callback<std::string, bool> callback)',
  );
});

test('registers a typed event and generates its emitter', () => {
  const header = generateFor(spec);
  expect(header).toContain(
    'this->template addEvent<jsi::Value>("onProgress");',
  );
  expect(header).toContain('void emitOnProgress(V value)');
  expect(header).toContain(
    'facebook::react::bridging::supportsToJs<V, double>',
  );
  expect(header).toContain('this->emitEvent("onProgress", std::move(value));');
});

test('rejects a value-returning method with a callback parameter', () => {
  expect(() =>
    generateFor(
      spec.replace(
        'lookup(key: string, callback: (value: string, found: boolean) => void): void;',
        'lookup(key: string, callback: (value: string, found: boolean) => void): string;',
      ),
    ),
  ).toThrow(
    /lookup: a method that takes a callback must return void or a Promise/u,
  );
});

test('rejects getConstants declared with a Promise', () => {
  expect(() =>
    generateFor(
      spec.replace(
        'greet(name: string): string;',
        'getConstants(): Promise<string>;',
      ),
    ),
  ).toThrow(/getConstants: getConstants cannot return a Promise/u);
});

test('describes an optional parameter as std::optional', () => {
  const header = generateFor(
    spec.replace(
      'record(value: string): void;',
      'record(value: string, tag?: string): void;',
    ),
  );
  expect(header).toContain(
    'record must be declared as void record(std::string value, std::optional<std::string> tag)',
  );
});

test('maps an ArrayBuffer to bytes it owns, in arguments and results', () => {
  const header = generateFor(
    spec
      .replace(
        'record(value: string): void;',
        'record(value: ArrayBuffer): void;',
      )
      .replace(
        'readonly onProgress: CodegenTypes.EventEmitter<number>;',
        'readonly onProgress: CodegenTypes.EventEmitter<ArrayBuffer>;',
      )
      .replace(
        'greet(name: string): string;',
        'greet(name: string): ArrayBuffer;',
      ),
  );
  expect(header).toContain('void record(std::vector<uint8_t> value);');
  expect(header).toContain('std::vector<uint8_t> greet(');
  expect(header).toContain('void emitOnProgress(V value)');
  expect(header).toContain('supportsToJs<V, std::vector<uint8_t>>');
});

test('names the method or event emitter a failing type came from', () => {
  expect(() =>
    generateFor(
      spec.replace(
        'record(value: string): void;',
        "record(value: 'a' | 1): void;",
      ),
    ),
  ).toThrow(
    /NativeProbe\.ts: record: unsupported spec type UnionTypeAnnotation with mixed member types/u,
  );
});

test('generates a payload-less event emitter and a Promise<void> method', () => {
  const header = generateFor(
    spec
      .replace(
        'readonly onProgress: CodegenTypes.EventEmitter<number>;',
        'readonly onDone: CodegenTypes.EventEmitter<void>;',
      )
      .replace(
        'greet(name: string): string;',
        'greet(name: string): string;\n  finish(): Promise<void>;',
      ),
  );
  expect(header).toContain('this->template addEvent<>("onDone");');
  expect(header).toContain('void emitOnDone() {');
  expect(header).toContain('this->emitEvent("onDone");');
  expect(header).toContain(
    '"finish must be declared as void finish(rngpui::Promise<>)',
  );
  expect(header).toContain(
    'this->template promiseMethod<&T::finish>("finish");',
  );
});
