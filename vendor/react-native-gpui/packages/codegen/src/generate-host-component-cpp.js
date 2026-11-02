import { createRequire } from 'node:module';
import path from 'node:path';
import { parseComponents, snakeCase } from './generate-rust-spec.js';

/// React Native's own C++ naming helpers, so an enum or a struct is named here
/// exactly as `Props.h` names it.
function loadNamingHelpers(hints) {
  const failures = [];
  for (const hint of hints) {
    try {
      const require = createRequire(hint);
      const utils = require('@react-native/codegen/lib/generators/Utils.js');
      const cpp = require('@react-native/codegen/lib/generators/components/CppHelpers.js');
      return {
        toSafeCppString: utils.toSafeCppString,
        getEnumName: utils.getEnumName,
        toIntEnumValueName: cpp.toIntEnumValueName,
      };
    } catch (error) {
      failures.push(`${hint}: ${error.message}`);
    }
  }
  throw new Error(
    `generate-host-component-cpp: cannot resolve @react-native/codegen; install it in the app.\n${failures.join('\n')}`,
  );
}

/// The size and alignment of a Rust scalar as `repr(C)` lays it out.
const SCALAR_LAYOUT = {
  i32: { size: 4, align: 4 },
  f32: { size: 4, align: 4 },
  f64: { size: 8, align: 8 },
  bool: { size: 1, align: 1 },
};

/// The C++ type React Native's generator gives a Rust scalar.
const SCALAR_CPP = {
  i32: 'int',
  f32: 'rr::Float',
  f64: 'double',
  bool: 'bool',
};

/// The C ABI type of a scalar shim argument or return.
const SCALAR_ABI = {
  i32: 'int32_t',
  f32: 'float',
  f64: 'double',
  bool: 'bool',
};

const alignUp = (value, align) => Math.ceil(value / align) * align;

/// `repr(C)` layout of a plain mirror: its size, alignment and field offsets.
function layoutOf(generator, mirror, cache = new Map()) {
  if (cache.has(mirror.name)) return cache.get(mirror.name);
  let offset = 0;
  let align = 1;
  const offsets = [];
  for (const field of mirror.fields) {
    let layout = SCALAR_LAYOUT[field.rustType];
    if (layout === undefined) {
      const nested = generator.mirrors.find(
        candidate => candidate.name === field.rustType,
      );
      if (nested !== undefined) {
        layout = layoutOf(generator, nested, cache);
      } else if (generator.enums.some(e => e.name === field.rustType)) {
        // `#[repr(i32)]`.
        layout = { size: 4, align: 4 };
      } else {
        throw new Error(
          `generate-host-component-cpp: unknown mirror field type ${field.rustType}`,
        );
      }
    }
    offset = alignUp(offset, layout.align);
    offsets.push(offset);
    offset += layout.size;
    align = Math.max(align, layout.align);
  }
  const result = { size: alignUp(offset, align), align, offsets };
  cache.set(mirror.name, result);
  return result;
}

/// How expensive a prop is to compare, so the change mask checks cheap fields
/// first: a 10,000-point chart must not compare every point to answer "did the
/// title change". Bits are positional, so the order changes nothing observable.
function compareCost(shape) {
  switch (shape.kind) {
    case 'scalar':
    case 'enum':
      return 0;
    case 'color':
    case 'string':
      return 1;
    case 'mirror':
    case 'view':
    case 'image':
      return 2;
    case 'mixed':
      return 4;
    default:
      return 3;
  }
}

const cppVar = value => value.replaceAll(/[^A-Za-z0-9_]/gu, '_');

/// One component's C++.
class ComponentCpp {
  constructor(generator, flags, naming) {
    this.generator = generator;
    this.flags = flags;
    this.naming = naming;
    this.name = generator.name;
    this.snake = snakeCase(generator.name);
    this.propsType = `rr::${generator.name}Props`;
    this.emitterType = `rr::${generator.name}EventEmitter`;
    this.out = [];
  }

  mirrorByName(name) {
    return this.generator.mirrors.find(mirror => mirror.name === name);
  }

  viewByName(name) {
    return this.generator.views.find(view => view.name === name);
  }

  cppMirror(name) {
    return `rr::${this.mirrorByName(name).cppName}`;
  }

  cppView(name) {
    return `rr::${this.viewByName(name).cppName}`;
  }

  enumCppName(declared) {
    return this.naming.getEnumName(this.name, declared.propName);
  }

  enumMemberCppName(declared, member) {
    return declared.numeric
      ? this.naming.toIntEnumValueName(declared.propName, member.text)
      : this.naming.toSafeCppString(member.text);
  }

  push(...lines) {
    this.out.push(...lines);
  }

  renderChecks() {
    const { generator } = this;
    this.push(`// ---- ${this.name}: layout checks`);
    this.push(
      `static_assert(std::is_base_of_v<rr::ViewProps, ${this.propsType}>);`,
    );
    const cache = new Map();
    for (const mirror of generator.mirrors) {
      const type = `rr::${mirror.cppName}`;
      const layout = layoutOf(generator, mirror, cache);
      this.push(`static_assert(std::is_standard_layout_v<${type}>);`);
      this.push(`static_assert(sizeof(${type}) == ${layout.size});`);
      this.push(`static_assert(alignof(${type}) == ${layout.align});`);
      mirror.fields.forEach((field, index) => {
        this.push(
          `static_assert(offsetof(${type}, ${field.jsName}) == ${layout.offsets[index]});`,
        );
        const cppType = SCALAR_CPP[field.rustType];
        if (cppType !== undefined) {
          this.push(
            `static_assert(std::is_same_v<decltype(${type}::${field.jsName}), ${cppType}>);`,
          );
        }
      });
    }
    for (const declared of generator.enums) {
      const type = `rr::${this.enumCppName(declared)}`;
      this.push(`static_assert(sizeof(${type}) == sizeof(int32_t));`);
      for (const member of declared.members) {
        this.push(
          `static_assert(static_cast<int32_t>(${type}::${this.enumMemberCppName(declared, member)}) == ${member.value});`,
        );
      }
    }
    for (const prop of generator.props) {
      const cppType =
        prop.shape.kind === 'scalar' ? SCALAR_CPP[prop.shape.rustType] : null;
      if (cppType !== null) {
        this.push(
          `static_assert(std::is_same_v<decltype(${this.propsType}::${prop.jsName}), ${cppType}>);`,
        );
      }
    }
    for (const view of generator.views) {
      for (const field of view.fields) {
        const cppType =
          field.shape.kind === 'scalar'
            ? SCALAR_CPP[field.shape.rustType]
            : null;
        if (cppType !== null) {
          this.push(
            `static_assert(std::is_same_v<decltype(rr::${view.cppName}::${field.jsName}), ${cppType}>);`,
          );
        }
      }
    }
    this.push('');
  }

  /// How to compare two values of a shape for the change mask.
  equal(shape, a, b) {
    switch (shape.kind) {
      case 'image':
        return `rn_eq_image(${a}, ${b})`;
      case 'mirror':
        return `eq_${cppVar(shape.name)}(${a}, ${b})`;
      case 'view':
        return `eq_${cppVar(shape.name)}(${a}, ${b})`;
      case 'array-plain':
        return `rn_eq_vec(${a}, ${b}, eq_${cppVar(shape.name)})`;
      case 'array-view':
        return `rn_eq_vec(${a}, ${b}, eq_${cppVar(shape.name)})`;
      default:
        return `${a} == ${b}`;
    }
  }

  /// A mirror's field is a scalar, an enum or another mirror.
  mirrorFieldEqual(field, a, b) {
    if (this.mirrorByName(field.rustType) !== undefined) {
      return `eq_${cppVar(field.rustType)}(${a}, ${b})`;
    }
    return `${a} == ${b}`;
  }

  renderEqualityDeclarations() {
    for (const mirror of this.generator.mirrors) {
      this.push(
        `bool eq_${cppVar(mirror.name)}(const rr::${mirror.cppName}& a, const rr::${mirror.cppName}& b);`,
      );
    }
    for (const view of this.generator.views) {
      this.push(
        `bool eq_${cppVar(view.name)}(const rr::${view.cppName}& a, const rr::${view.cppName}& b);`,
      );
    }
  }

  renderEqualityDefinitions() {
    for (const mirror of this.generator.mirrors) {
      const terms = mirror.fields.map(field =>
        this.mirrorFieldEqual(field, `a.${field.jsName}`, `b.${field.jsName}`),
      );
      this.push(
        `bool eq_${cppVar(mirror.name)}(const rr::${mirror.cppName}& a, const rr::${mirror.cppName}& b) {`,
        `  return ${terms.length === 0 ? 'true' : terms.join(' &&\n         ')};`,
        '}',
        '',
      );
    }
    for (const view of this.generator.views) {
      const terms = view.fields.map(field =>
        this.equal(field.shape, `a.${field.jsName}`, `b.${field.jsName}`),
      );
      this.push(
        `bool eq_${cppVar(view.name)}(const rr::${view.cppName}& a, const rr::${view.cppName}& b) {`,
        `  return ${terms.length === 0 ? 'true' : terms.join(' &&\n         ')};`,
        '}',
        '',
      );
    }
  }

  renderChanged() {
    const { generator } = this;
    this.push(
      `void ${this.snake}_changed(const rr::Props& rawBefore, const rr::Props& rawAfter, uint64_t* words) {`,
      `  const auto& before = static_cast<const ${this.propsType}&>(rawBefore);`,
      `  const auto& after = static_cast<const ${this.propsType}&>(rawAfter);`,
    );
    const ordered = [...generator.props].sort(
      (left, right) =>
        compareCost(left.shape) - compareCost(right.shape) ||
        left.index - right.index,
    );
    for (const prop of ordered) {
      const same = this.equal(
        prop.shape,
        `before.${prop.jsName}`,
        `after.${prop.jsName}`,
      );
      const word = Math.floor(prop.index / 64);
      const bit = prop.index % 64;
      this.push(
        `  if (!(${same})) {`,
        `    words[${word}] |= uint64_t{1} << ${bit};`,
        '  }',
      );
    }
    this.push('}', '');
  }

  /// The shims for one owner: the props handle, or a view's struct address.
  renderAccessors({ shimPrefix, owner, fields }) {
    for (const field of fields) {
      const shim = `${shimPrefix}_${snakeCase(field.jsName)}`;
      const value = `p.${field.jsName}`;
      const head = (returns, extra = '') =>
        `${returns} ${shim}(const void* handle${extra}) {`;
      this.push(`// ${field.jsName}`);
      switch (field.shape.kind) {
        case 'scalar':
          this.push(
            head(SCALAR_ABI[field.shape.rustType]),
            owner,
            `  return ${value};`,
            '}',
          );
          break;
        case 'string':
          this.push(
            head('RnGpuiStr'),
            owner,
            `  return rn_str(${value});`,
            '}',
          );
          break;
        case 'enum':
          this.push(
            head('int32_t'),
            owner,
            `  return static_cast<int32_t>(${value});`,
            '}',
          );
          break;
        case 'color':
          this.push(
            head('RnGpuiOptU32'),
            owner,
            `  return rn_color(${value});`,
            '}',
          );
          break;
        case 'image':
        case 'view':
          this.push(head('const void*'), owner, `  return &${value};`, '}');
          break;
        case 'mixed':
          this.push(
            head('void', ', RnTextSink sink, void* context'),
            owner,
            `  rn_text(${value}, sink, context);`,
            '}',
          );
          break;
        case 'mirror':
          this.push(
            head(this.cppMirror(field.shape.name)),
            owner,
            `  return ${value};`,
            '}',
          );
          break;
        case 'array-scalar':
          this.push(
            `static_assert(sizeof(decltype(${value.replace('p.', `std::declval<${field.ownerType}>().`)})::value_type) == sizeof(${SCALAR_ABI[field.shape.rustType]}));`,
          );
          this.push(
            head('RnGpuiSlice'),
            owner,
            `  return rn_slice(${value});`,
            '}',
          );
          break;
        case 'array-plain':
          this.push(
            head('RnGpuiSlice'),
            owner,
            `  return rn_slice(${value});`,
            '}',
          );
          break;
        case 'array-string':
          this.push(
            `size_t ${shim}_len(const void* handle) {`,
            owner,
            `  return ${value}.size();`,
            '}',
            `RnGpuiStr ${shim}_at(const void* handle, size_t index) {`,
            owner,
            `  return rn_str(${value}[index]);`,
            '}',
          );
          break;
        case 'array-view':
          this.push(
            `size_t ${shim}_len(const void* handle) {`,
            owner,
            `  return ${value}.size();`,
            '}',
            `const void* ${shim}_at(const void* handle, size_t index) {`,
            owner,
            `  return &${value}[index];`,
            '}',
          );
          break;
        default:
          throw new Error(
            `generate-host-component-cpp: unsupported accessor shape ${field.shape.kind}`,
          );
      }
      this.push('');
    }
  }

  /// The shim parameters and the statements that fill the event struct, walking
  /// the payload leaf by leaf in the order the Rust half flattens it.
  flatten(declared, valueExpression, prefix, params, statements) {
    for (const field of declared.fields) {
      const argument = cppVar(
        prefix === '' ? field.name : `${prefix}_${field.name}`,
      );
      const target = `${valueExpression}.${field.jsName}`;
      switch (field.shape.kind) {
        case 'scalar':
          params.push(`${SCALAR_ABI[field.shape.rustType]} ${argument}`);
          statements.push(`${target} = ${argument};`);
          break;
        case 'enum':
          params.push(`int32_t ${argument}`);
          statements.push(
            `${target} = static_cast<decltype(${target})>(${argument});`,
          );
          break;
        case 'string':
          params.push(
            `const uint8_t* ${argument}_data`,
            `size_t ${argument}_len`,
          );
          statements.push(
            `${target}.assign(reinterpret_cast<const char*>(${argument}_data), ${argument}_len);`,
          );
          break;
        case 'array-scalar':
          params.push(
            `const ${SCALAR_ABI[field.shape.rustType]}* ${argument}_data`,
            `size_t ${argument}_len`,
          );
          statements.push(
            `${target}.assign(${argument}_data, ${argument}_data + ${argument}_len);`,
          );
          break;
        case 'array-string':
          params.push(
            `const RnGpuiStr* ${argument}_data`,
            `size_t ${argument}_len`,
          );
          statements.push(
            `${target}.clear();`,
            `for (size_t i = 0; i < ${argument}_len; ++i) {`,
            `  ${target}.emplace_back(reinterpret_cast<const char*>(${argument}_data[i].data), ${argument}_data[i].len);`,
            '}',
          );
          break;
        case 'object': {
          const nested = this.generator.payloads.find(
            candidate => candidate.name === field.shape.typeName,
          );
          this.flatten(nested, target, argument, params, statements);
          break;
        }
        default:
          throw new Error(
            `generate-host-component-cpp: unsupported event payload shape ${field.shape.kind}`,
          );
      }
    }
  }

  renderEvents() {
    for (const event of this.generator.events) {
      const shim = `rn_gpui_${this.snake}_event_${snakeCase(event.name)}`;
      this.push(`// ${event.jsName}`);
      if (event.payload === null) {
        this.push(
          `void ${shim}(const void* emitter) {`,
          `  rngpui::hostEmitter<${this.emitterType}>(emitter).${event.jsName}({});`,
          '}',
          '',
        );
        continue;
      }
      const params = [];
      const statements = [];
      this.flatten(event.payload, 'value', '', params, statements);
      this.push(
        `void ${shim}(${['const void* emitter', ...params].join(', ')}) {`,
        `  ${this.emitterType}::${event.payload.name} value{};`,
        ...statements.map(statement => `  ${statement}`),
        `  rngpui::hostEmitter<${this.emitterType}>(emitter).${event.jsName}(std::move(value));`,
        '}',
        '',
      );
    }
  }

  /// The check and the conversion of one command argument, as a
  /// `HostCommandValue` appended to `values`.
  commandArgument(parameter, position) {
    const arg = `args[${position}]`;
    const type = parameter.rustType;
    const name = parameter.jsName;
    const fail = what =>
      `    LOG(ERROR) << "[host-component] ${this.name}.${'${command}'}: argument '${name}' must be ${what}";\n    return true;`;
    switch (type) {
      case 'i32':
      case 'f32':
      case 'f64':
        return [
          `  if (!${arg}.isNumber()) {`,
          fail('a number'),
          '  }',
          `  values.push_back(rn_number(${arg}.asDouble()));`,
        ];
      case 'bool':
        return [
          `  if (!${arg}.isBool()) {`,
          fail('a boolean'),
          '  }',
          `  values.push_back(rn_bool(${arg}.asBool()));`,
        ];
      case 'String':
        return [
          `  if (!${arg}.isString()) {`,
          fail('a string'),
          '  }',
          `  values.push_back(rn_string(${arg}.getString()));`,
        ];
      case 'Vec<i32>':
      case 'Vec<f32>':
      case 'Vec<f64>':
        return [
          `  if (!rn_all(${arg}, [](const folly::dynamic& v) { return v.isNumber(); })) {`,
          fail('an array of numbers'),
          '  }',
          `  values.push_back(rn_numbers(${arg}));`,
        ];
      case 'Vec<bool>':
        return [
          `  if (!rn_all(${arg}, [](const folly::dynamic& v) { return v.isBool(); })) {`,
          fail('an array of booleans'),
          '  }',
          `  values.push_back(rn_bools(${arg}));`,
        ];
      case 'Vec<String>':
        return [
          `  if (!rn_all(${arg}, [](const folly::dynamic& v) { return v.isString(); })) {`,
          fail('an array of strings'),
          '  }',
          `  values.push_back(rn_strings(${arg}));`,
        ];
      default:
        throw new Error(
          `generate-host-component-cpp: unsupported command argument ${type}`,
        );
    }
  }

  renderCommand() {
    const { commands } = this.generator;
    this.push(
      `bool ${this.snake}_command(int32_t tag, const std::string& command, const folly::dynamic& args) {`,
    );
    commands.forEach((command, commandIndex) => {
      this.push(`  if (command == ${JSON.stringify(command.jsName)}) {`);
      this.push(
        `    if (!args.isArray() || args.size() != ${command.params.length}) {`,
        `      LOG(ERROR) << "[host-component] ${this.name}.${command.jsName} takes ${command.params.length} argument(s)";`,
        '      return true;',
        '    }',
        '    std::vector<rngpui::HostCommandValue> values;',
        `    values.reserve(${command.params.length});`,
      );
      command.params.forEach((parameter, position) => {
        const lines = this.commandArgument(parameter, position)
          .map(line => line.replace('${command}', command.jsName))
          .map(line => `  ${line}`);
        this.push(...lines);
      });
      this.push(
        `    rngpui::dispatchHostCommand(tag, ${commandIndex}, std::move(values));`,
        '    return true;',
        '  }',
      );
    });
    this.push('  (void)tag;', '  (void)args;', '  return false;', '}', '');
  }

  render() {
    const { generator, flags } = this;
    const nameVariable = `k${this.name}Name`;
    const shadow = `${this.name}ShadowNode`;
    const descriptor = `${this.name}Descriptor`;
    this.push(`// ================= ${this.name} =================`, '');
    this.push('namespace {', '');
    this.push(
      `inline constexpr char ${nameVariable}[] = ${JSON.stringify(this.name)};`,
    );
    if (flags.container) {
      this.push(
        `using ${shadow} = rngpui::GpuiHostContainerShadowNode<${nameVariable}, ${this.propsType}, ${this.emitterType}>;`,
        `using ${descriptor} = rngpui::GpuiHostContainerDescriptor<${shadow}>;`,
      );
    } else {
      this.push(
        `using ${shadow} = rngpui::GpuiHostLeafShadowNode<${nameVariable}, ${this.propsType}, ${this.emitterType}, ${flags.measured ? 'true' : 'false'}>;`,
        `using ${descriptor} = rr::ConcreteComponentDescriptor<${shadow}>;`,
      );
    }
    this.push('');
    this.renderChecks();
    this.renderEqualityDeclarations();
    this.push('');
    this.renderEqualityDefinitions();
    this.renderChanged();
    this.renderCommand();
    this.push(`} // namespace`, '');

    this.push('extern "C" {', '');
    const propsOwner = `  const auto& p = rngpui::hostProps<${this.propsType}>(handle);`;
    this.renderAccessors({
      shimPrefix: `rn_gpui_${this.snake}_props`,
      owner: propsOwner,
      fields: generator.props.map(prop => ({
        ...prop,
        ownerType: this.propsType,
      })),
    });
    for (const view of generator.views) {
      this.renderAccessors({
        shimPrefix: `rn_gpui_${snakeCase(view.name)}`,
        owner: `  const auto& p = *static_cast<const rr::${view.cppName}*>(handle);`,
        fields: view.fields.map(field => ({
          ...field,
          ownerType: `rr::${view.cppName}`,
        })),
      });
    }
    this.renderEvents();
    this.push('} // extern "C"', '');
  }

  registration(index) {
    const { flags } = this;
    const nameVariable = `k${this.name}Name`;
    return [
      '  {',
      '    rngpui::HostComponentEntry entry;',
      `    entry.index = ${index};`,
      `    entry.name = ${nameVariable};`,
      `    entry.handle = ${this.name}ShadowNode::Handle();`,
      `    entry.measured = ${flags.measured};`,
      `    entry.container = ${flags.container};`,
      `    entry.nativeSurface = ${flags.nativeSurface};`,
      `    entry.provider = &rr::concreteComponentDescriptorProvider<${this.name}Descriptor>;`,
      `    entry.changed = &${this.snake}_changed;`,
      `    entry.changeWords = ${this.generator.changeWords};`,
      `    entry.command = &${this.snake}_command;`,
      '    rngpui::registerHostComponentEntry(entry);',
      '  }',
    ];
  }
}

const PROLOGUE = `#include "GpuiHostComponentsCpp.h"

#include <react/renderer/graphics/Color.h>
#include <react/renderer/imagemanager/primitives.h>

#include <folly/json.h>
#include <glog/logging.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace rr = facebook::react;

namespace {
// Borrowed views of C++ values, as the ABI structs core declares carry them.
inline RnGpuiStr rn_str(const std::string& text) {
  return RnGpuiStr{reinterpret_cast<const uint8_t*>(text.data()), text.size()};
}

template <class T>
inline RnGpuiSlice rn_slice(const std::vector<T>& values) {
  return RnGpuiSlice{values.data(), values.size()};
}

inline RnGpuiOptU32 rn_color(const rr::SharedColor& color) {
  // React Native's unset color is zero.
  return RnGpuiOptU32{static_cast<uint32_t>(*color), static_cast<bool>(color)};
}

// A \`folly::dynamic\` has no layout to lend out: it is serialised once and the
// bytes are handed to a callback that copies them.
using RnTextSink = void (*)(void* context, const uint8_t* data, size_t len);

inline void rn_text(const folly::dynamic& value, RnTextSink sink, void* context) {
  const std::string text = folly::toJson(value);
  sink(context, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}

inline bool rn_eq_image(const rr::ImageSource& a, const rr::ImageSource& b) {
  return a.type == b.type && a.uri == b.uri && a.bundle == b.bundle &&
      a.scale == b.scale && a.size.width == b.size.width &&
      a.size.height == b.size.height && a.body == b.body &&
      a.method == b.method;
}

template <class T, class Equal>
inline bool rn_eq_vec(const std::vector<T>& a, const std::vector<T>& b, Equal equal) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (!equal(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

// Command arguments, validated by the generated dispatcher below.
inline rngpui::HostCommandValue rn_number(double value) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::Number;
  out.number = value;
  return out;
}

inline rngpui::HostCommandValue rn_bool(bool value) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::Bool;
  out.number = value ? 1 : 0;
  return out;
}

inline rngpui::HostCommandValue rn_string(const std::string& value) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::String;
  out.text = value;
  return out;
}

template <class Predicate>
inline bool rn_all(const folly::dynamic& array, Predicate predicate) {
  if (!array.isArray()) {
    return false;
  }
  for (const auto& item : array) {
    if (!predicate(item)) {
      return false;
    }
  }
  return true;
}

inline rngpui::HostCommandValue rn_numbers(const folly::dynamic& array) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::Numbers;
  for (const auto& item : array) {
    out.numbers.push_back(item.asDouble());
  }
  return out;
}

inline rngpui::HostCommandValue rn_bools(const folly::dynamic& array) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::Bools;
  for (const auto& item : array) {
    out.numbers.push_back(item.asBool() ? 1 : 0);
  }
  return out;
}

inline rngpui::HostCommandValue rn_strings(const folly::dynamic& array) {
  rngpui::HostCommandValue out;
  out.kind = rngpui::HostCommandValue::Strings;
  for (const auto& item : array) {
    out.texts.push_back(item.getString());
  }
  return out;
}
} // namespace
`;

/// The C++ source for every component spec in \`specPaths\`.
export function generateHostComponentCpp({
  specPaths,
  libraryName,
  components,
}) {
  const generators = parseComponents({ specPaths });
  if (generators.length === 0) {
    return '';
  }
  const naming = loadNamingHelpers([
    ...specPaths.map(specPath => path.resolve(specPath)),
    path.join(process.cwd(), 'package.json'),
    import.meta.url,
  ]);
  const parts = [];
  const registrations = [];
  for (const generator of generators) {
    const declared = components[generator.name];
    if (declared === undefined) {
      throw new Error(
        `${generator.specPath}: ${generator.name} is not declared under platforms.desktop.hostComponents in react-native.config.js`,
      );
    }
    if (generator.component.interfaceOnly !== true) {
      throw new Error(
        `${generator.specPath}: ${generator.name} must be created with codegenNativeComponent(..., { interfaceOnly: true }); core supplies the shadow node and the descriptor, so React Native must not generate its own`,
      );
    }
    if (declared.measured && declared.container) {
      throw new Error(
        `${generator.name}: a host component cannot be both measured and a container; Fabric's MeasurableYogaNode requires a leaf, and a leaf cannot hold children`,
      );
    }
    const cpp = new ComponentCpp(generator, declared, naming);
    cpp.render();
    parts.push(cpp.out.join('\n'));
    registrations.push(cpp.registration(declared.index).join('\n'));
  }
  const identifier = cppVar(libraryName);
  return `${[
    '// Generated by @react-native-gpui/codegen from TypeScript specs; do not edit.',
    '//',
    '// The C++ half of the host component API: it implements the shims the generated',
    "// Rust declares, reading React Native's own generated props in place, and",
    "// registers each component with core's registry.",
    '',
    `#include <react/renderer/components/${libraryName}/EventEmitters.h>`,
    `#include <react/renderer/components/${libraryName}/Props.h>`,
    '',
    PROLOGUE,
    ...parts,
    `extern "C" void rn_gpui_register_host_components_${identifier}() {`,
    ...registrations,
    '}',
  ].join('\n')}\n`;
}
