import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  generateRustSpec,
  snakeCase,
  pascalCase,
} from './generate-rust-spec.js';

// The fixture spec is also what the integration crate compiles, so the two
// stay in step.
const fixtureSpec = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/core/ReactGpui/rn-gpui-module/tests/generated/specs/NativeProbe.ts',
);

const generated = () => generateRustSpec({ specPaths: [fixtureSpec] });

const generateFor = spec => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-spec-'));
  const file = path.join(directory, 'NativeTemp.ts');
  fs.writeFileSync(file, spec);
  return generateRustSpec({ specPaths: [file] });
};

const fixture = fs.readFileSync(fixtureSpec, 'utf8');

test('names are converted to Rust', () => {
  expect(snakeCase('greetLater')).toBe('greet_later');
  expect(snakeCase('addListener')).toBe('add_listener');
  expect(snakeCase('URLForID')).toBe('url_for_id');
  expect(pascalCase('onProgress')).toBe('OnProgress');
  expect(pascalCase('no-op')).toBe('NoOp');
});

describe('the generated glue', () => {
  const header = generated();

  test('describes the spec with a trait and a descriptor', () => {
    expect(header).toContain('pub trait NativeProbeSpec:');
    expect(header).toContain('fn new(events: NativeProbeEvents) -> Self;');
    expect(header).toContain(
      'pub fn native_probe_module<M: NativeProbeSpec>() -> ModuleDescriptor {',
    );
    expect(header).toContain('name: "NativeProbe"');
    expect(header).toContain('thread: M::THREAD');
    expect(header).toContain(
      'create: |events| Arc::new(NativeProbeInstance::<M>::new(events))',
    );
  });

  test('maps every type of the table', () => {
    expect(header).toContain(
      'fn scalar(&self, text: String, count: f64, whole: i32, flag: bool) -> Result<bool, ModuleError>;',
    );
    // An optional parameter and a nullable one.
    expect(header).toContain(
      'fn optional_value(&self, maybe: Option<String>, nullable: Option<String>) -> Result<Option<String>, ModuleError>;',
    );
    expect(header).toContain(
      'fn lists(&self, items: Vec<String>, readonly_items: Vec<f64>) -> Result<Vec<i32>, ModuleError>;',
    );
    // A named alias, used twice.
    expect(header).toContain(
      'fn options(&self, value: Options, again: Options) -> Result<Options, ModuleError>;',
    );
    // A TypeScript enum and a literal union.
    expect(header).toContain(
      'fn level(&self, level: Level) -> Result<LevelResult, ModuleError>;',
    );
    // A numeric enum, and names that are Rust keywords.
    expect(header).toContain(
      'fn rank(&self, value: Rank) -> Result<Rank, ModuleError>;',
    );
    expect(header).toContain(
      'fn r#match(&self, text: String) -> Result<String, ModuleError>;',
    );
    expect(header).toContain('pub r#type: String,');
    // `Object` and `UnsafeObject` stay untyped.
    expect(header).toContain(
      'fn anything(&self, value: Value) -> Result<Value, ModuleError>;',
    );
    // A void method, a Promise, and Promise<void>.
    expect(header).toContain('fn nothing(&self);');
    expect(header).toContain(
      'async fn later(&self, text: String) -> Result<String, ModuleError>;',
    );
    expect(header).toContain(
      'async fn done(&self) -> Result<(), ModuleError>;',
    );
    // A callback parameter.
    expect(header).toContain(
      'fn lookup(&self, key: String, callback: Box<dyn FnOnce(String, bool) + Send>);',
    );
  });

  test('generates the events handle and the descriptor events', () => {
    expect(header).toContain('pub struct NativeProbeEvents {');
    expect(header).toContain('pub fn on_progress(&self, value: f64) {');
    expect(header).toContain(
      'self.emitter.emit("onProgress", Some(value.into_value()));',
    );
    expect(header).toContain('pub fn on_done(&self) {');
    expect(header).toContain('self.emitter.emit("onDone", None);');
    expect(header).toContain(
      'pub fn send_event(&self, name: &str, body: Value) {',
    );
    expect(header).toContain('EventInfo {');
    expect(header).toContain('name: "onDone"');
    expect(header).toContain('has_value: false');
  });

  test('generates a struct for a named alias with both conversions', () => {
    expect(header).toContain('pub struct Options {');
    expect(header).toContain('pub label: Option<String>,');
    expect(header).toContain('pub count: i32,');
    expect(header).toContain('pub mode: OptionsMode,');
    expect(header).toContain('impl FromValue for Options {');
    expect(header).toContain('fields.take_optional::<String>(path, "label")?');
    expect(header).toContain('impl IntoValue for Options {');
    // The inline object of `inline(value: { x: number; y?: string })`.
    expect(header).toContain('pub struct InlineValue {');
    expect(header).toContain('pub x: f64,');
    expect(header).toContain('pub y: Option<String>,');
    // The nested object inside the alias.
    expect(header).toContain('pub struct OptionsNested {');
  });

  test('maps an ArrayBuffer to the crate type, in arguments and results', () => {
    const mapped = generateFor(
      fixture
        .replace(
          'nothing(): void;',
          'nothing(buffer: ArrayBuffer): void;\n  bytes(): ArrayBuffer;',
        )
        .replace(
          'readonly onProgress: CodegenTypes.EventEmitter<number>;',
          'readonly onProgress: CodegenTypes.EventEmitter<ArrayBuffer>;',
        ),
    );
    expect(mapped).toContain('fn nothing(&self, buffer: ArrayBuffer);');
    expect(mapped).toContain(
      'fn bytes(&self) -> Result<ArrayBuffer, ModuleError>;',
    );
    expect(mapped).toContain('pub fn on_progress(&self, value: ArrayBuffer)');
    expect(mapped).toContain('ArrayBuffer, EventEmitter, EventInfo');
  });

  test('drops the unusable derives when a struct holds an untyped field', () => {
    expect(header).toContain('pub struct Meta {');
    expect(header).toContain('pub extra: Option<Value>,');
    expect(header).toContain('pub list: Option<Vec<Value>>,');
    expect(header).not.toContain('Clone, PartialEq)]\npub struct Meta');
  });

  test('generates a numeric enum from a TypeScript enum', () => {
    expect(header).toContain('pub enum Rank {');
    expect(header).toContain('Value::Number(number) => match number as i64 {');
    expect(header).toContain('0 => Ok(Self::Low),');
    expect(header).toContain('Self::High => Value::Number(1 as f64),');
    expect(header).toContain('expected one of 0, 1, got {other}');
  });

  test('generates enums for a TypeScript enum and a literal union', () => {
    expect(header).toContain('pub enum Level {');
    expect(header).toContain('Low,');
    expect(header).toContain('Self::Low => Value::String("low".to_string()),');
    expect(header).toContain('pub enum OptionsMode {');
    expect(header).toContain('"left" => Ok(Self::Left),');
  });

  test('routes each method through the entry point of its kind', () => {
    expect(header).toContain(
      'let result = rn_gpui_module::__private::catch(|| self.0.scalar(text, count, whole, flag))??;',
    );
    // A void method is prepared on the calling thread and run on the module's.
    expect(header).toContain(
      'rn_gpui_module::__private::run_void("NativeProbe.nothing", move || self.0.nothing());',
    );
    expect(header).toContain(
      "    fn prepare_void(\n        self: Arc<Self>,\n        method: usize,\n        args: Vec<Value>,\n    ) -> Result<Box<dyn FnOnce() + Send + 'static>, ModuleError> {",
    );
    expect(header).toContain(
      'let result = rn_gpui_module::__private::catch_async(self.0.later(text)).await??;',
    );
    expect(header).toContain('kind: MethodKind::Promise,');
    // `optionalValue(maybe?, nullable)` needs both arguments, `nothing()` none.
    expect(header).toContain(
      'arg_count: 2,\n                required_args: 2,',
    );
    expect(header).toContain(
      'arg_count: 0,\n                required_args: 0,',
    );
    expect(header).toContain('returns_void: true,');
    expect(header).toContain('callback_args: &[1],');
    // The callback is built from a RawCallback and consumes it. The cursor has
    // a name of its own, so an object parameter cannot shadow it.
    expect(header).toContain(
      'let callback = arguments_.next_callback("callback")?;',
    );
    expect(header).toContain(
      'callback.invoke(vec![a0.into_value(), a1.into_value()])',
    );
  });
});

describe('the generator fails', () => {
  test('for a callback parameter on a value-returning method', () => {
    expect(() =>
      generateFor(
        fixture.replace(
          'lookup(key: string, callback: (value: string, found: boolean) => void): void;',
          'lookup(key: string, callback: (value: string, found: boolean) => void): string;',
        ),
      ),
    ).toThrow(
      /NativeTemp\.ts: lookup: a method that takes a callback must return void or a Promise/u,
    );
  });

  test('for a type it cannot map, naming the method', () => {
    expect(() =>
      generateFor(
        fixture.replace('nothing(): void;', 'nothing(rank: 1 | 2): void;'),
      ),
    ).toThrow(
      /NativeTemp\.ts: nothing: unsupported union member NumberLiteralTypeAnnotation/u,
    );
  });

  test('for a host object, naming the spec', () => {
    // React Native's parser rejects host types before the generator sees them.
    expect(() =>
      generateFor(
        fixture.replace('nothing(): void;', 'nothing(host: HostObject): void;'),
      ),
    ).toThrow(/NativeTemp: Unrecognized generic type 'HostObject'/u);
  });

  test('for a recursive alias', () => {
    expect(() =>
      generateFor(
        fixture.replace(
          'export type Options = {',
          'export type Options = {\n  child?: Options;',
        ),
      ),
    ).toThrow(/recursive type alias Options is not supported/u);
  });
});

test('reads a callback after an object parameter', () => {
  const generated =
    generateFor(`import {TurboModuleRegistry, type TurboModule} from 'react-native';

export type Args = {
  title?: string;
  buttons?: Array<Object>;
};

export interface Spec extends TurboModule {
  readonly show: (args: Args, callback: (id: number, value: string) => void) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Temp');
`);
  expect(generated).toContain('let args: Args = arguments_.next("args")?;');
  expect(generated).toContain(
    'let callback = arguments_.next_callback("callback")?;',
  );
});
