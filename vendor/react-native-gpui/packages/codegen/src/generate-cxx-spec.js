#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const toPascalCase = value =>
  value.replaceAll(/(?:^|[^A-Za-z0-9]+)([A-Za-z0-9])/gu, (_match, character) =>
    character.toUpperCase(),
  );

/**
 * The C++ type an implementation declares for one spec type, plus the JSI type
 * it converts to. A named object type maps to the struct React Native's own
 * generator emits for that type alias in `<libraryName>JSI.h`.
 */
function cppTypeOf(annotation, context) {
  const { hasteModuleName, aliasMap, fail } = context;
  const recurse = inner => cppTypeOf(inner, context);
  switch (annotation.type) {
    case 'StringTypeAnnotation':
    case 'StringLiteralTypeAnnotation':
      return { cpp: 'std::string', jsi: 'jsi::String' };
    case 'NumberTypeAnnotation':
    case 'DoubleTypeAnnotation':
    case 'FloatTypeAnnotation':
    case 'NumberLiteralTypeAnnotation':
      return { cpp: 'double', jsi: 'double' };
    case 'Int32TypeAnnotation':
      return { cpp: 'int32_t', jsi: 'int' };
    case 'BooleanTypeAnnotation':
    case 'BooleanLiteralTypeAnnotation':
      return { cpp: 'bool', jsi: 'bool' };
    case 'GenericObjectTypeAnnotation':
    case 'ObjectTypeAnnotation':
      return { cpp: 'folly::dynamic', jsi: 'jsi::Object' };
    case 'MixedTypeAnnotation':
      return { cpp: 'folly::dynamic', jsi: 'jsi::Value' };
    case 'ArrayBufferTypeAnnotation':
      // Copied, so a module-thread method never holds a runtime-bound object.
      return { cpp: 'std::vector<uint8_t>', jsi: 'jsi::ArrayBuffer' };
    case 'VoidTypeAnnotation':
      return { cpp: 'void', jsi: 'jsi::Value' };
    case 'ArrayTypeAnnotation': {
      const element = recurse(annotation.elementType);
      return { cpp: `std::vector<${element.cpp}>`, jsi: 'jsi::Array' };
    }
    case 'FunctionTypeAnnotation':
      return {
        cpp: `rngpui::Callback<${annotation.params
          .map(parameter => cppParameterOf(parameter, context))
          .join(', ')}>`,
        jsi: 'jsi::Function',
      };
    case 'NullableTypeAnnotation': {
      const inner = recurse(annotation.typeAnnotation);
      return { cpp: `std::optional<${inner.cpp}>`, jsi: inner.jsi };
    }
    case 'ReservedTypeAnnotation':
      if (annotation.name === 'RootTag') {
        return { cpp: 'double', jsi: 'double' };
      }
      return fail(`ReservedTypeAnnotation(${annotation.name})`);
    case 'EnumDeclaration':
      switch (annotation.memberType) {
        case 'NumberTypeAnnotation':
          return { cpp: 'double', jsi: 'jsi::Value' };
        case 'StringTypeAnnotation':
          return { cpp: 'std::string', jsi: 'jsi::String' };
        default:
          return fail(`EnumDeclaration(${annotation.memberType})`);
      }
    case 'UnionTypeAnnotation': {
      const memberTypes = new Set(annotation.types.map(member => member.type));
      if (memberTypes.size !== 1) {
        return fail('UnionTypeAnnotation with mixed member types');
      }
      switch ([...memberTypes][0]) {
        case 'StringLiteralTypeAnnotation':
          return { cpp: 'std::string', jsi: 'jsi::String' };
        case 'NumberLiteralTypeAnnotation':
          return { cpp: 'double', jsi: 'double' };
        case 'BooleanLiteralTypeAnnotation':
          return { cpp: 'bool', jsi: 'bool' };
        default:
          return fail('UnionTypeAnnotation');
      }
    }
    case 'TypeAliasTypeAnnotation': {
      const alias = aliasMap?.[annotation.name];
      if (!alias) {
        return fail(`unresolved type alias ${annotation.name}`);
      }
      if (
        alias.type === 'ObjectTypeAnnotation' &&
        alias.properties.length > 0
      ) {
        return {
          cpp: `${hasteModuleName}${annotation.name}`,
          jsi: 'jsi::Object',
        };
      }
      return recurse(alias);
    }
    default:
      return fail(annotation.type);
  }
}

/// The C++ type an implementation declares for one parameter: a parameter the
/// spec marks optional may be omitted, so it is `std::optional<T>`.
const cppParameterOf = (parameter, context) => {
  const { cpp } = cppTypeOf(parameter.typeAnnotation, context);
  return parameter.optional &&
    parameter.typeAnnotation.type !== 'NullableTypeAnnotation'
    ? `std::optional<${cpp}>`
    : cpp;
};

const isObjectType = annotation =>
  annotation.type === 'ObjectTypeAnnotation' ||
  annotation.type === 'GenericObjectTypeAnnotation';

function methodOf(name, typeAnnotation, context) {
  const method = `${context.location}: ${name}`;
  const returnType = typeAnnotation.returnTypeAnnotation;
  const kind =
    returnType.type === 'VoidTypeAnnotation'
      ? 'void'
      : returnType.type === 'PromiseTypeAnnotation'
        ? 'promise'
        : 'value';
  if (name === 'getConstants' && kind === 'promise') {
    throw new Error(`${method}: getConstants cannot return a Promise`);
  }
  if (
    kind === 'value' &&
    typeAnnotation.params.some(
      parameter => parameter.typeAnnotation.type === 'FunctionTypeAnnotation',
    )
  ) {
    throw new Error(
      `${method}: a method that takes a callback must return void or a Promise`,
    );
  }
  const parameters = typeAnnotation.params.map(parameter => ({
    ...parameter,
    context,
  }));
  const described = parameters
    .map(parameter => `${cppParameterOf(parameter, context)} ${parameter.name}`)
    .join(', ');
  // A value method runs on the JS thread, so an object return may stay a JSI
  // object; everything else uses the converted type.
  const valueReturn = () =>
    isObjectType(returnType)
      ? 'jsi::Object'
      : cppTypeOf(returnType, context).cpp;
  const promiseType = () => {
    const element = returnType.elementType;
    return `rngpui::Promise<${
      element && element.type !== 'VoidTypeAnnotation'
        ? cppTypeOf(element, context).cpp
        : ''
    }>`;
  };
  const signature =
    kind === 'value'
      ? `${valueReturn()} ${name}(jsi::Runtime& rt${described ? `, ${described}` : ''})`
      : kind === 'void'
        ? `void ${name}(${described})`
        : `void ${name}(${described ? `${described}, ` : ''}${promiseType()})`;
  // A value method always takes the runtime; a void or Promise method takes it
  // only when the module asks for the JS thread, and a Promise method takes the
  // promise last.
  const countParts = [];
  if (kind === 'value') {
    countParts.push('1');
  } else {
    countParts.push('(T::kThread == rngpui::ModuleThread::JS ? 1 : 0)');
  }
  if (parameters.length > 0) {
    countParts.push(`${parameters.length}`);
  }
  if (kind === 'promise') {
    countParts.push('1');
  }
  const parameterCount = countParts.join(' + ');
  const registration =
    kind === 'value'
      ? `valueMethod`
      : kind === 'void'
        ? `voidMethod`
        : `promiseMethod`;
  return {
    name,
    parameterCount,
    message:
      kind === 'value'
        ? `${name} must be declared as ${signature}`
        : `${name} must be declared as ${signature}; with kThread = JS it takes jsi::Runtime& rt first`,
    registration: `this->template ${registration}<&T::${name}>("${name}");`,
  };
}

function eventOf(eventEmitter, context) {
  const payload = eventEmitter.typeAnnotation.typeAnnotation;
  const name = eventEmitter.name;
  const emitName = `emit${toPascalCase(name)}`;
  if (payload.type === 'VoidTypeAnnotation') {
    return {
      registration: `this->template addEvent<>("${name}");`,
      emitter: `  void ${emitName}() {
    this->emitEvent("${name}");
  }`,
    };
  }
  const type = cppTypeOf(payload, context);
  return {
    registration: `this->template addEvent<jsi::Value>("${name}");`,
    emitter: `  template <typename V>
  void ${emitName}(V value) {
    static_assert(
        facebook::react::bridging::supportsToJs<V, ${type.cpp}>,
        "${name}: the value cannot be converted to the event's JS type");
    this->emitEvent("${name}", std::move(value));
  }`,
  };
}

/**
 * The spec header for one codegen library: a `<SpecFile>Spec` class per
 * NativeModule that registers its methods, typed events and emitters with
 * `rngpui::TurboModuleBase`.
 */
export function generateCxxSpec({ libraryName, schema, specPaths = {} }) {
  const modules = Object.entries(schema.modules ?? {}).filter(
    ([, module]) => module.type === 'NativeModule',
  );
  const classes = modules.map(([hasteModuleName, module]) => {
    const location = specPaths[hasteModuleName] ?? hasteModuleName;
    // `where` is the method or event emitter a failing type came from, so the
    // error names it and not just the spec file.
    const contextFor = where => ({
      hasteModuleName,
      aliasMap: module.aliasMap,
      location,
      where,
      fail: typeName => {
        throw new Error(
          `${location}${where ? `: ${where}` : ''}: unsupported spec type ${typeName}`,
        );
      },
    });
    const methods = module.spec.methods.map(({ name, typeAnnotation }) =>
      methodOf(name, typeAnnotation, contextFor(name)),
    );
    const events = (module.spec.eventEmitters ?? []).map(eventEmitter =>
      eventOf(eventEmitter, contextFor(eventEmitter.name)),
    );
    const assertions = methods
      .map(
        method => `    static_assert(
        facebook::react::bridging::getParameterCount(&T::${method.name}) ==
            ${method.parameterCount},
        "${method.message}");`,
      )
      .join('\n');
    const registrations = [
      ...methods.map(method => `    ${method.registration}`),
      ...events.map(event => `    ${event.registration}`),
    ].join('\n');
    const emitters = events.map(event => event.emitter).join('\n\n');
    return `template <typename T>
class ${hasteModuleName}Spec : public rngpui::TurboModuleBase<T> {
 public:
  static constexpr std::string_view kModuleName = "${module.moduleName}";

 protected:
  explicit ${hasteModuleName}Spec(
      std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
      : rngpui::TurboModuleBase<T>(
            std::string{kModuleName}, std::move(jsInvoker)) {
${assertions}
${registrations}
  }
${emitters ? `\n${emitters}\n` : ''}};`;
  });
  return `// Generated by @react-native-gpui/codegen; do not edit.
#pragma once

#include "GpuiTurboModule.h"

#include <${libraryName}JSI.h>

#include <memory>
#include <string>
#include <string_view>
#include <utility>

namespace facebook::react {

${classes.join('\n\n')}

} // namespace facebook::react
`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const inputs = process.argv.slice(2);
  const outputPath = inputs.pop();
  const libraryName = inputs.pop();
  if (!outputPath || !libraryName || inputs.length === 0) {
    throw new Error(
      'usage: generate-cxx-spec <libraryName> <NativeModule.ts>... <output.h>',
    );
  }
  const require = createRequire(import.meta.url);
  const {
    combineSchemasInFileList,
  } = require('@react-native/codegen/lib/cli/combine/combine-js-to-schema');
  const specPaths = Object.fromEntries(
    inputs.map(specPath => [
      path.basename(specPath).replace(/\.[^.]+$/u, ''),
      specPath,
    ]),
  );
  const schema = combineSchemasInFileList(inputs, 'desktop', null, libraryName);
  const generated = generateCxxSpec({ libraryName, schema, specPaths });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Keep the mtime stable so C++ that includes it is not recompiled.
  if (
    !fs.existsSync(outputPath) ||
    fs.readFileSync(outputPath, 'utf8') !== generated
  ) {
    fs.writeFileSync(outputPath, generated);
  }
}
