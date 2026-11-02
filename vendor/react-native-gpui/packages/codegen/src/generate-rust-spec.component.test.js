import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { generateRustSpec } from './generate-rust-spec.js';
import { KITCHEN_SINK_SPEC as FIXTURE } from './kitchen-sink-spec.js';

/// Generates from a spec body, written to a temporary file because the parser
/// reads the spec from disk.
const generateFrom = spec => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rust-component-spec-'),
  );
  const file = path.join(directory, 'FixtureComponentSpec.ts');
  fs.writeFileSync(file, spec);
  return generateRustSpec({ specPaths: [file] });
};

/// A spec with `props` as its only props, for one table row at a time.
const withProps = props =>
  `import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

export interface NativeProps extends ViewProps {
${props}
}

const Temp: any = null;

export default codegenNativeComponent<NativeProps>('Temp', { interfaceOnly: true });
`;

const header = generateFrom(FIXTURE);

const countOf = (text, needle) => text.split(needle).length - 1;

describe('a component spec becomes the generated API', () => {
  test('renders the seven artifacts 5.1 lists', () => {
    expect(header).toContain('pub struct FixtureChartProps {');
    expect(header).toContain('pub struct FixtureChartChanged {');
    expect(header).toContain('pub struct FixtureChartEvents<');
    expect(header).toContain('pub trait FixtureChartSpec: Sized +');
    expect(header).toContain('pub struct FixtureChartContext {');
    expect(header).toContain(
      'pub const fn fixture_chart_component<T: FixtureChartSpec>() -> FixtureChartComponent<T> {',
    );
    // The `#[repr(C)]` mirror the props and the C++ file agree on.
    expect(header).toContain(
      '#[repr(C)]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct FixtureChartPoints {',
    );
  });

  test('generates the trait of 5.1 exactly', () => {
    expect(header).toContain(
      'fn create(props: &FixtureChartProps, cx: &mut FixtureChartContext) -> Self;',
    );
    expect(header).toContain(
      'fn update(\n        &mut self,\n        props: &FixtureChartProps,\n        changed: FixtureChartChanged,\n        cx: &mut FixtureChartContext,\n    );',
    );
    expect(header).toContain(
      'fn render(\n        &mut self,\n        props: &FixtureChartProps,\n        window: &mut Window,\n        cx: &mut FixtureChartContext,\n    ) -> AnyElement;',
    );
  });

  test('gives every command a typed method, in snake_case', () => {
    expect(header).toContain(
      'fn select_point(&mut self, index: i32, cx: &mut FixtureChartContext);',
    );
    expect(header).toContain(
      'fn report_series(&mut self, values: Vec<f64>, cx: &mut FixtureChartContext);',
    );
    expect(header).toContain(
      'fn set_title(&mut self, title: String, cx: &mut FixtureChartContext);',
    );
  });

  test('generates the context the trait methods take', () => {
    expect(header).toContain('pub struct FixtureChartContext {');
    expect(header).toContain('host: HostContext,');
    expect(header).toContain(
      "pub fn events(&mut self) -> FixtureChartEvents<'_> {",
    );
    expect(header).toContain(
      'pub fn set_intrinsic_size(&mut self, width: f32, height: f32) {',
    );
    expect(header).toContain(
      'pub fn set_insets(&mut self, top: f32, right: f32, bottom: f32, left: f32) {',
    );
  });

  test('generates one typed event method per event', () => {
    expect(header).toContain('pub struct OnPointSelected {');
    expect(header).toContain('pub index: i32,');
    expect(header).toContain('pub label: String,');
    expect(header).toContain(
      'pub fn point_selected(&mut self, value: OnPointSelected) {',
    );
    expect(header).toContain('pub fn done(&mut self) {');
    expect(header).toContain('pub struct OnRichNested {');
    expect(header).toContain('pub fn rich(&mut self, value: OnRich) {');
  });

  test('queues an event with an owned payload instead of sending it mid-call', () => {
    expect(header).toContain('self.context.host.queue_event(move || {');
    expect(header).toContain('let emitter = self.context.emitter.clone();');
    expect(header).toContain('rn_gpui_fixture_chart_event_point_selected(');
    expect(header).toContain(
      'pub struct FixtureChartContext {\n    host: HostContext,\n    emitter: EmitterHandle,\n}',
    );
  });

  test('gives a container an optional overlay that defaults to none', () => {
    expect(header).toContain('fn render_overlay(');
    expect(header).toContain(') -> Option<AnyElement> {');
    expect(header).toContain('let _ = (props, window, cx);');
  });

  test('wires the spec into core through a generated instance', () => {
    expect(header).toContain(
      'struct FixtureChartInstance<T: FixtureChartSpec> {',
    );
    expect(header).toContain(
      'impl<T: FixtureChartSpec> HostObject for FixtureChartInstance<T> {',
    );
    expect(header).toContain(
      'self.props = unsafe { FixtureChartProps::from_handle(props.as_ptr()) };',
    );
    expect(header).toContain(
      'let changed = FixtureChartChanged::from_slice(changed);',
    );
    expect(header).toContain(
      '0 => self.component.select_point(args[0].to_i32(), &mut cx),',
    );
    expect(header).toContain(
      '1 => self.component.report_series(args[0].to_f64_vec(), &mut cx),',
    );
    expect(header).toContain(
      '2 => self.component.set_title(args[0].to_string_value(), &mut cx),',
    );
    expect(header).toContain(
      'impl<T: FixtureChartSpec> HostComponentSpec for FixtureChartComponent<T> {',
    );
  });

  test('carries the declared shape on the registration value', () => {
    expect(header).toContain('pub const NAME: &\'static str = "FixtureChart";');
    expect(header).toContain(
      'pub const PROPS: &\'static [&\'static str] = &[\n        "lineWidth",\n        "opacity",\n        "ratio",\n        "flag",',
    );
    expect(header).toContain(
      'pub const EVENTS: &\'static [&\'static str] = &["onPointSelected", "onRich", "onDone"];',
    );
    expect(header).toContain(
      'pub const COMMANDS: &\'static [&\'static str] = &["selectPoint", "reportSeries", "setTitle"];',
    );
  });
});

describe('the props view reads each type of the 5.2 table', () => {
  test('a scalar is the value', () => {
    expect(header).toContain('pub fn line_width(&self) -> i32 {');
    expect(header).toContain('pub fn opacity(&self) -> f32 {');
    expect(header).toContain('pub fn ratio(&self) -> f64 {');
    expect(header).toContain('pub fn flag(&self) -> bool {');
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_line_width(props: *const core::ffi::c_void) -> i32;',
    );
  });

  test('a WithDefault prop is the value, with the default already applied by React Native', () => {
    expect(header).toContain('pub fn tick_count(&self) -> i32 {');
    expect(header).not.toContain('pub fn tick_count(&self) -> Option<i32>');
    expect(header).toContain('pub fn mode(&self) -> FixtureChartMode {');
  });

  test('a string union is a #[repr(i32)] enum whose discriminants match C++', () => {
    expect(header).toContain('#[repr(i32)]');
    expect(header).toContain(
      'pub enum FixtureChartMode {\n    /// `line`\n    Line = 0,\n    /// `bar`\n    Bar = 1,\n}',
    );
    expect(header).toContain('pub const fn as_raw(self) -> i32 {');
    expect(header).toContain('pub fn from_raw(value: i32) -> Self {');
  });

  test('a string is borrowed as &str', () => {
    expect(header).toContain('pub fn title(&self) -> &str {');
    expect(header).toContain(
      'unsafe { rn_gpui_str(rn_gpui_fixture_chart_props_title(self.handle)) }',
    );
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_title(props: *const core::ffi::c_void) -> RnGpuiStr;',
    );
    expect(header).toContain('pub struct RnGpuiStr {');
  });

  test('a ColorValue is Option<u32>', () => {
    expect(header).toContain('pub fn line_color(&self) -> Option<u32> {');
    expect(header).toContain('if color.present {');
    expect(header).toContain('Some(color.value)');
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_line_color(props: *const core::ffi::c_void) -> RnGpuiOptU32;',
    );
  });

  test('an ImageSource is a view with borrowed accessors', () => {
    expect(header).toContain('pub fn icon(&self) -> RnGpuiImageSource {');
    expect(header).toContain('pub fn uri(&self) -> &str {');
    expect(header).toContain('pub fn scale(&self) -> f32 {');
    expect(header).toContain('pub fn width(&self) -> f32 {');
    expect(header).toContain('pub fn height(&self) -> f32 {');
    expect(header).toContain(
      'fn rn_gpui_image_source_uri(image: *const core::ffi::c_void) -> RnGpuiStr;',
    );
  });

  test('an array of plain structs is a borrowed &[T] of the #[repr(C)] mirror', () => {
    expect(header).toContain('pub fn points(&self) -> &[FixtureChartPoints] {');
    expect(header).toContain(
      'unsafe { rn_gpui_slice(rn_gpui_fixture_chart_props_points(self.handle)) }',
    );
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_points(props: *const core::ffi::c_void) -> RnGpuiSlice;',
    );
    expect(header).toContain(
      'pub struct FixtureChartPoints {\n    /// `x`\n    pub x: f64,\n    /// `y`\n    pub y: f64,\n}',
    );
  });

  test('an array of scalars is a borrowed &[T]', () => {
    expect(header).toContain('pub fn values(&self) -> &[f64] {');
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_values(props: *const core::ffi::c_void) -> RnGpuiSlice;',
    );
  });

  test('an array of strings is read one string at a time, without allocating', () => {
    expect(header).toContain("pub fn labels(&self) -> RnGpuiStrArray<'_> {");
    expect(header).toContain(
      'let len = unsafe { rn_gpui_fixture_chart_props_labels_len(self.handle) };',
    );
    expect(header).toContain(
      'unsafe { RnGpuiStrArray::new(self.handle, len, rn_gpui_fixture_chart_props_labels_at) }',
    );
    expect(header).toContain("pub struct RnGpuiStrArray<'a> {");
    expect(header).not.toContain('RnGpuiStrSlice');
  });

  test('an object with strings or arrays is a view with accessors', () => {
    expect(header).toContain("pub struct FixtureChartCard<'a> {");
    expect(header).toContain('pub fn title(&self) -> &str {');
    expect(header).toContain(
      "pub fn nested(&self) -> FixtureChartCardNested<'_> {",
    );
    expect(header).not.toContain(
      '#[repr(C)]\n#[derive(Clone, Copy, Debug, PartialEq)]\npub struct FixtureChartCard {',
    );
    expect(header).toContain("pub struct FixtureChartCardNested<'a> {");
    expect(header).toContain('pub fn flag(&self) -> bool {');
    expect(header).toContain("pub fn names(&self) -> RnGpuiStrArray<'_> {");
  });

  test('an array of non-plain structs is a length plus indexed views', () => {
    expect(header).toContain(
      "pub fn cards(&self) -> FixtureChartCardsSlice<'_> {",
    );
    expect(header).toContain(
      'let len = unsafe { rn_gpui_fixture_chart_props_cards_len(self.handle) };',
    );
    expect(header).toContain("pub struct FixtureChartCardsSlice<'a> {");
    expect(header).toContain(
      "pub fn get(&self, index: usize) -> Option<FixtureChartCards<'a>> {",
    );
    expect(header).toContain(
      'let handle = unsafe { rn_gpui_fixture_chart_props_cards_at(self.handle, index) };',
    );
    expect(header).toContain(
      'fn rn_gpui_fixture_chart_props_cards_len(props: *const core::ffi::c_void) -> usize;',
    );
    expect(header).toContain('fn rn_gpui_fixture_chart_props_cards_at(');
    expect(header).toContain('index: usize,');
    expect(header).toContain(') -> *const core::ffi::c_void;');
  });

  test('UnsafeMixed is a Value, converted on the first read only', () => {
    expect(header).toContain('pub fn extra(&self) -> &Value {');
    expect(header).toContain('mixed_extra: std::cell::OnceCell<Value>,');
    expect(header).toContain('self.mixed_extra.get_or_init(|| {');
    expect(header).toContain('rn_gpui_collect_text,');
    expect(header).toContain(
      'react_native_gpui::host_component::parse_value(&text)',
    );
    expect(header).toContain('fn rn_gpui_fixture_chart_props_extra(');
    expect(header).toContain('sink: RnGpuiTextSink,');
    expect(header).toContain('context: *mut core::ffi::c_void,');
  });

  test('an array of booleans is rejected: std::vector<bool> is bit-packed', () => {
    expect(() =>
      generateFrom(withProps('  flags?: ReadonlyArray<boolean>;')),
    ).toThrow(
      /prop flags: an array of booleans is a bit-packed std::vector<bool>/u,
    );
  });

  test('a borrow is tied to &self, so it cannot outlive the handle', () => {
    expect(header).toContain('pub fn title(&self) -> &str {');
    expect(header).toContain('pub fn points(&self) -> &[FixtureChartPoints] {');
    expect(header).toContain("pub fn card(&self) -> FixtureChartCard<'_> {");
    expect(header).not.toContain('pub fn title(&self) -> String {');
  });
});

describe('the change mask', () => {
  test('has one bit per prop, with a getter named after it', () => {
    expect(header).toContain('words: [u64; 1],');
    expect(header).toContain('pub const fn line_width(&self) -> bool {');
    expect(header).toContain('self.words[0] & (1u64 << 0) != 0');
    expect(header).toContain('pub const fn extra(&self) -> bool {');
    expect(header).toContain('self.words[0] & (1u64 << 14) != 0');
    expect(header).not.toContain('pub const fn on_done(&self) -> bool {');
  });

  test('reports a token with changed.report_token(), as 5.1 writes it', () => {
    const reported = generateFrom(withProps('  reportToken?: Int32;'));
    expect(reported).toContain('pub const fn report_token(&self) -> bool {');
    expect(reported).toContain('self.words[0] & (1u64 << 0) != 0');
    expect(header).toContain('pub const fn points(&self) -> bool {');
  });

  test('has none/from_words/words/is_empty for core and for tests', () => {
    expect(header).toContain('pub const fn none() -> Self {');
    expect(header).toContain('Self { words: [0; 1] }');
    expect(header).toContain(
      'pub const fn from_words(words: [u64; 1]) -> Self {',
    );
    expect(header).toContain('pub const fn words(&self) -> [u64; 1] {');
    expect(header).toContain('pub fn is_empty(&self) -> bool {');
    expect(header).toContain('self.words.iter().all(|word| *word == 0)');
    expect(header).toContain('#[repr(transparent)]');
  });

  test('uses one u64 up to 64 props and documents the threshold', () => {
    expect(header).toContain('**Up to 64 props fit one `u64`;**');
    expect(header).toContain('pub const CHANGE_WORDS: usize = 1;');
    expect(header).not.toContain('fn rn_gpui_fixture_chart_changed(');
    expect(header).toContain('pub fn from_slice(words: &[u64]) -> Self {');
  });

  test('uses a word per 64 props above 64', () => {
    const props = Array.from(
      { length: 130 },
      (_, index) => `  prop${index}?: Int32;`,
    ).join('\n');
    const many = generateFrom(withProps(props));
    expect(many).toContain('words: [u64; 3],');
    expect(many).toContain('pub const CHANGE_WORDS: usize = 3;');
    expect(many).toContain('pub const fn prop129(&self) -> bool {');
    expect(many).toContain('self.words[2] & (1u64 << 1) != 0');
    expect(many).not.toContain('fn rn_gpui_temp_changed(');
    expect(many).toContain('pub fn from_slice(words: &[u64]) -> Self {');
    expect(many).toContain('let mut out = [0u64; 3];');
  });

  test('is transparent over its word array, so the C++ comparison writes it in place', () => {
    expect(header).toContain('#[repr(transparent)]');
    expect(header).toContain('words: [u64; 1],');
    expect(header).toMatch(
      /#\[repr\(transparent\)\][\s\S]{0,200}pub struct FixtureChartChanged \{\n {4}words:/u,
    );
  });

  test('is empty for a spec with no props', () => {
    const empty = generateFrom(withProps('  title?: string;'));
    expect(empty).toContain('words: [u64; 1],');
  });
});

describe('the generated file', () => {
  test('emits the ABI types once, however many components it declares', () => {
    expect(countOf(header, 'pub struct RnGpuiStr {')).toBe(1);
    expect(countOf(header, 'pub struct RnGpuiSlice {')).toBe(1);
    expect(countOf(header, 'pub struct RnGpuiImageSource {')).toBe(1);
    const withoutImage = generateFrom(withProps('  title?: string;'));
    expect(withoutImage).not.toContain('pub struct RnGpuiImageSource {');
    expect(withoutImage).toContain('pub struct RnGpuiStr {');
  });

  test('names shims after the component, the prop and the path, for the C++ half', () => {
    expect(header).toContain('fn rn_gpui_fixture_chart_props_line_width(');
    expect(header).toContain('fn rn_gpui_fixture_chart_card_nested(');
    expect(header).toContain('fn rn_gpui_fixture_chart_event_point_selected(');
    expect(header).toContain('fn rn_gpui_fixture_chart_props_cards_len(');
    expect(header).toContain('fn rn_gpui_fixture_chart_props_cards_at(');
    expect(header).toContain('fn rn_gpui_fixture_chart_card_nested_names_len(');
    expect(header).toContain('fn rn_gpui_fixture_chart_card_nested_names_at(');
  });

  test('converts a props string with a checked conversion, never unchecked', () => {
    expect(countOf(header, 'from_utf8_unchecked(')).toBe(0);
    expect(header).toContain('match core::str::from_utf8(bytes)');
  });

  test('imports only what a component needs', () => {
    expect(header).toContain('use gpui::{AnyElement, Window};');
    expect(header).toContain(
      'EmitterHandle, HostArg, HostComponentSpec, HostContext, HostObject, PropsHandle, Value,',
    );
    expect(header).not.toContain('use rn_gpui_module::');
  });

  test('still generates a module for a NativeModule spec', async () => {
    const { generateRustSpec: generate } =
      await import('./generate-rust-spec.js');
    const fixtureSpec = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../packages/core/ReactGpui/rn-gpui-module/tests/generated/specs/NativeProbe.ts',
    );
    const module = generate({ specPaths: [fixtureSpec] });
    expect(module).toContain('pub trait NativeProbeSpec:');
    expect(module).toContain('use rn_gpui_module::');
    expect(module).not.toContain('pub struct NativeProbeProps {');
  });
});

describe('the generator fails, naming the prop', () => {
  test('for an array of a type it cannot lay out', () => {
    expect(() =>
      generateFrom(
        withProps('  icons?: ReadonlyArray<CodegenTypes.UnsafeMixed>;'),
      ),
    ).toThrow(
      /FixtureComponentSpec\.ts: prop icons: unsupported array element MixedTypeAnnotation/u,
    );
  });

  test('for a prop type it does not know', () => {
    expect(() => generateFrom(withProps('  host?: HostObject;'))).toThrow(
      /Unknown prop type for "host": "HostObject"/u,
    );
  });
});
