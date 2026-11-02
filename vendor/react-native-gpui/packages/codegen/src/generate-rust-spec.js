// Generates the Rust glue a TurboModule library implements: one trait per spec
// file, the events handle, the value structs and enums, and the descriptor that
// registers the module with `rn-gpui-module`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/// `@react-native/codegen` belongs to the app, not to this package, so it is
/// resolved from the spec being generated and then from here.
export function loadTypeScriptParser(hints) {
  const failures = [];
  for (const hint of hints) {
    try {
      const require = createRequire(hint);
      return require('@react-native/codegen/lib/parsers/typescript/parser.js')
        .TypeScriptParser;
    } catch (error) {
      failures.push(`${hint}: ${error.message}`);
    }
  }
  throw new Error(
    `generate-rust-spec: cannot resolve @react-native/codegen; install it in the app.\n${failures.join('\n')}`,
  );
}

const RUST_KEYWORDS = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
]);
const RAW_IDENTIFIER_INVALID = new Set(['crate', 'self', 'super', 'Self']);

export function rustIdentifier(name) {
  if (!RUST_KEYWORDS.has(name)) return name;
  return RAW_IDENTIFIER_INVALID.has(name) ? `${name}_` : `r#${name}`;
}

export function snakeCase(name) {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase();
}

export function pascalCase(name) {
  const words = name.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const joined = words
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join('');
  if (joined.length === 0) return 'Value';
  return /^[0-9]/u.test(joined) ? `V${joined}` : joined;
}

function variantName(name, index) {
  const cleaned = name.replaceAll(/[^A-Za-z0-9]+/gu, ' ').trim();
  if (cleaned.length === 0) return `Value${index}`;
  const variant = pascalCase(cleaned);
  return RUST_KEYWORDS.has(variant) ? `${variant}Value` : variant;
}

const pascal = name => pascalCase(name);

/// A Rust string literal, so generated messages survive quotes in spec values.
const rustString = text => JSON.stringify(text);

class SpecGenerator {
  constructor({ specPath, hasteModuleName, module }) {
    this.specPath = specPath;
    this.hasteModuleName = hasteModuleName;
    this.module = module;
    this.spec = module.spec;
    this.aliasMap = module.aliasMap ?? {};
    this.enumMap = module.enumMap ?? {};
    // Anonymous object types and string literal unions are named after the
    // place they appear, so the same shape is generated once.
    this.anonymous = new Map();
    this.types = [];
    this.typeNames = new Set();
  }

  fail(where, detail) {
    throw new Error(`${this.specPath}: ${where}: ${detail}`);
  }

  /// The name JS asks for. The Rust names come from the spec file instead.
  get moduleName() {
    return this.module.moduleName ?? this.hasteModuleName;
  }

  get stem() {
    return path.basename(this.specPath).replace(/\.[^.]+$/u, '');
  }

  get traitName() {
    return `${this.stem}Spec`;
  }

  get eventsName() {
    return `${this.stem}Events`;
  }

  get instanceName() {
    return `${this.stem}Instance`;
  }

  get descriptorName() {
    const stem = this.stem.replace(/^Native/u, '');
    return `native_${snakeCase(stem)}_module`;
  }

  /// Maps a type annotation to a Rust type, generating a struct or enum when
  /// the annotation names one.
  typeOf(annotation, context) {
    const { where } = context;
    switch (annotation.type) {
      case 'StringTypeAnnotation':
        return 'String';
      case 'NumberTypeAnnotation':
      case 'DoubleTypeAnnotation':
      case 'FloatTypeAnnotation':
        return 'f64';
      case 'Int32TypeAnnotation':
        return 'i32';
      case 'BooleanTypeAnnotation':
        return 'bool';
      case 'VoidTypeAnnotation':
        return '()';
      case 'NullableTypeAnnotation':
        return `Option<${this.typeOf(annotation.typeAnnotation, context)}>`;
      case 'ArrayTypeAnnotation':
        return `Vec<${this.typeOf(annotation.elementType, context)}>`;
      case 'GenericObjectTypeAnnotation':
        return 'Value';
      case 'ArrayBufferTypeAnnotation':
        return 'ArrayBuffer';
      case 'ObjectTypeAnnotation':
        return this.objectType(annotation, context);
      case 'TypeAliasTypeAnnotation': {
        const alias = this.aliasMap[annotation.name];
        if (!alias) this.fail(where, `unknown type alias ${annotation.name}`);
        if (alias.type === 'ObjectTypeAnnotation') {
          return this.objectType(alias, {
            ...context,
            name: annotation.name,
            aliasName: annotation.name,
          });
        }
        if (alias.type === 'EnumDeclaration') {
          return this.enumType(annotation.name, alias);
        }
        this.fail(where, `unsupported type alias ${annotation.name}`);
        break;
      }
      case 'EnumDeclaration': {
        const declared = this.enumMap[annotation.name];
        if (!declared) this.fail(where, `unknown enum ${annotation.name}`);
        return this.enumType(annotation.name, declared);
      }
      case 'UnionTypeAnnotation':
        return this.unionType(annotation, context);
      case 'FunctionTypeAnnotation':
        if (context.callbackAllowed !== true) {
          this.fail(
            where,
            'a method that takes a callback must return void or a Promise',
          );
        }
        return this.callbackType(annotation, context);
      default:
        this.fail(where, `unsupported spec type ${annotation.type}`);
        break;
    }
    return 'Value';
  }

  objectType(annotation, context) {
    if (context.aliasName && this.typeNames.has(context.aliasName)) {
      return context.aliasName;
    }
    const name = this.uniqueName(
      context.aliasName ?? context.name ?? `${pascal(context.where)}Value`,
    );
    // Recursion would need a boxed field, which this generator does not write.
    const nested = annotation.properties ?? [];
    for (const property of nested) {
      if (this.referencesAlias(property.typeAnnotation, context.aliasName)) {
        this.fail(
          context.where,
          `recursive type alias ${context.aliasName ?? name} is not supported`,
        );
      }
    }
    this.typeNames.add(name);
    const fields = nested.map(property => ({
      name: rustIdentifier(snakeCase(property.name)),
      jsName: property.name,
      optional: property.optional === true,
      nullable: property.typeAnnotation.type === 'NullableTypeAnnotation',
      annotation: property.typeAnnotation,
    }));
    const struct = {
      kind: 'struct',
      name,
      fields: fields.map(field => ({
        ...field,
        rustType: this.fieldType(field, { ...context, where: context.where }),
      })),
    };
    // Nested objects are named after their parent, so register the struct
    // before generating the fields that may add more types.
    this.types.push(struct);
    return name;
  }

  fieldType(field, context) {
    const inner = this.typeOf(field.annotation, {
      ...context,
      name: `${context.name ?? ''}${pascal(field.jsName)}`,
      aliasName: undefined,
      callbackAllowed: false,
    });
    if (field.optional) {
      return inner.startsWith('Option<') ? inner : `Option<${inner}>`;
    }
    return inner;
  }

  referencesAlias(annotation, aliasName) {
    if (!aliasName) return false;
    if (annotation.type === 'TypeAliasTypeAnnotation') {
      return annotation.name === aliasName;
    }
    if (annotation.type === 'NullableTypeAnnotation') {
      return this.referencesAlias(annotation.typeAnnotation, aliasName);
    }
    if (annotation.type === 'ArrayTypeAnnotation') {
      return this.referencesAlias(annotation.elementType, aliasName);
    }
    if (annotation.type === 'ObjectTypeAnnotation') {
      return (annotation.properties ?? []).some(property =>
        this.referencesAlias(property.typeAnnotation, aliasName),
      );
    }
    return false;
  }

  uniqueName(base) {
    let name = base;
    let suffix = 2;
    while (this.typeNames.has(name)) {
      name = `${base}${suffix}`;
      suffix += 1;
    }
    this.typeNames.add(name);
    return name;
  }

  unionType(annotation, context) {
    const members = (annotation.types ?? []).map(member => {
      if (member.type !== 'StringLiteralTypeAnnotation') {
        this.fail(context.where, `unsupported union member ${member.type}`);
      }
      return { name: String(member.value), value: member.value };
    });
    if (members.length === 0) this.fail(context.where, 'empty union type');
    const name = this.uniqueName(
      context.name ?? `${pascal(context.where)}Value`,
    );
    this.pushEnum(name, {
      memberType: 'StringTypeAnnotation',
      members: members.map(member => ({
        name: member.name,
        value: { type: 'StringLiteralTypeAnnotation', value: member.value },
      })),
    });
    return name;
  }

  enumType(name, declaration) {
    if (this.typeNames.has(name)) return name;
    this.typeNames.add(name);
    this.pushEnum(name, declaration);
    return name;
  }

  pushEnum(name, declaration) {
    // As React Native's own generator does, anything that is not a string enum
    // is numeric.
    const numeric = declaration.memberType !== 'StringTypeAnnotation';
    const members = (declaration.members ?? []).map((member, index) => {
      const value = member.value?.value ?? member.name;
      if (numeric && typeof value !== 'number') {
        this.fail(
          `enum ${name}`,
          `expected a numeric member for ${member.name}`,
        );
      }
      if (!numeric && typeof value !== 'string') {
        this.fail(
          `enum ${name}`,
          `expected a string member for ${member.name}`,
        );
      }
      return {
        variant: variantName(member.name ?? String(value), index),
        value,
      };
    });
    this.types.push({ kind: 'enum', name, numeric, members });
  }

  callbackType(annotation, context) {
    const args = (annotation.params ?? []).map((parameter, index) => {
      const declared = this.typeOf(parameter.typeAnnotation, {
        where: `${context.where} callback argument ${index}`,
        callbackAllowed: false,
      });
      return parameter.optional && !declared.startsWith('Option<')
        ? `Option<${declared}>`
        : declared;
    });
    return `Box<dyn FnOnce(${args.join(', ')}) + Send>`;
  }

  methods() {
    return (this.spec.methods ?? []).map((method, index) => {
      const signature = method.typeAnnotation;
      const returns = signature.returnTypeAnnotation;
      const where = method.name;
      const kind =
        returns.type === 'VoidTypeAnnotation'
          ? 'void'
          : returns.type === 'PromiseTypeAnnotation'
            ? 'promise'
            : 'value';
      if (method.name === 'getConstants' && kind === 'promise') {
        this.fail(where, 'getConstants cannot return a Promise');
      }
      const callbackAllowed = kind !== 'value';
      const params = (signature.params ?? []).map((parameter, position) => ({
        jsName: parameter.name,
        name: rustIdentifier(snakeCase(parameter.name)),
        annotation: parameter.typeAnnotation,
        optional: parameter.optional === true,
        nullable: parameter.typeAnnotation.type === 'NullableTypeAnnotation',
        position,
        isCallback: parameter.typeAnnotation.type === 'FunctionTypeAnnotation',
      }));
      for (const parameter of params) {
        const declared = this.typeOf(parameter.annotation, {
          where,
          name: `${pascal(method.name)}${pascal(parameter.jsName)}`,
          callbackAllowed,
        });
        parameter.rustType =
          parameter.optional && !declared.startsWith('Option<')
            ? `Option<${declared}>`
            : declared;
        if (parameter.isCallback) {
          parameter.callbackArgTypes = (parameter.annotation.params ?? []).map(
            (callbackArg, argumentIndex) =>
              this.typeOf(callbackArg.typeAnnotation, {
                where,
                name: `${pascal(method.name)}${pascal(parameter.jsName)}Argument${argumentIndex}`,
                callbackAllowed: false,
              }),
          );
        }
      }
      let rustReturn = '()';
      let returnsVoid = false;
      if (kind === 'value') {
        rustReturn = this.typeOf(returns, {
          where,
          name: `${pascal(method.name)}Result`,
          callbackAllowed: false,
        });
      } else if (kind === 'promise') {
        const element = returns.elementType;
        if (element.type === 'VoidTypeAnnotation') {
          returnsVoid = true;
        } else {
          rustReturn = this.typeOf(element, {
            where,
            name: `${pascal(method.name)}Result`,
            callbackAllowed: false,
          });
        }
      }
      // A parameter the spec marks optional may be omitted, so the required
      // count stops after the last one that is not.
      const requiredArgs = params.reduce(
        (required, parameter, position) =>
          parameter.optional ? required : position + 1,
        0,
      );
      return {
        index,
        jsName: method.name,
        requiredArgs,
        name: rustIdentifier(snakeCase(method.name)),
        kind,
        params,
        rustReturn,
        returnsVoid,
        callbackArgs: params
          .filter(parameter => parameter.isCallback)
          .map(parameter => parameter.position),
      };
    });
  }

  events() {
    return (this.spec.eventEmitters ?? []).map(eventEmitter => {
      const annotation = eventEmitter.typeAnnotation.typeAnnotation;
      const hasValue = annotation.type !== 'VoidTypeAnnotation';
      return {
        jsName: eventEmitter.name,
        name: rustIdentifier(snakeCase(eventEmitter.name)),
        hasValue,
        rustType: hasValue
          ? this.typeOf(annotation, {
              where: `event ${eventEmitter.name}`,
              name: `${pascal(eventEmitter.name)}Payload`,
              callbackAllowed: false,
            })
          : null,
      };
    });
  }
}

/// Parses the component specs in `specPaths` into the same generators the Rust
/// half renders from, so the C++ half is derived from one model of each prop and
/// the two cannot disagree about a shape.
export function parseComponents({ specPaths }) {
  const TypeScriptParser = loadTypeScriptParser([
    ...specPaths.map(specPath => path.resolve(specPath)),
    path.join(process.cwd(), 'package.json'),
    import.meta.url,
  ]);
  const parser = new TypeScriptParser();
  const found = [];
  for (const specPath of specPaths) {
    const schema = parser.parseFile(specPath);
    for (const [hasteModuleName, module] of Object.entries(
      schema.modules ?? {},
    )) {
      if (module.type !== 'Component') continue;
      for (const [componentName, component] of Object.entries(
        module.components ?? {},
      )) {
        const generator = new ComponentGenerator({
          specPath,
          hasteModuleName,
          componentName,
          component,
        });
        generator.collect();
        found.push(generator);
      }
    }
  }
  return found;
}

export function generateRustSpec({ specPaths }) {
  const TypeScriptParser = loadTypeScriptParser([
    ...specPaths.map(specPath => path.resolve(specPath)),
    path.join(process.cwd(), 'package.json'),
    import.meta.url,
  ]);
  const parser = new TypeScriptParser();
  const modules = [];
  const components = [];
  let componentsUseImageSource = false;
  for (const specPath of specPaths) {
    const schema = parser.parseFile(specPath);
    const entries = Object.entries(schema.modules ?? {});
    if (entries.length !== 1) {
      throw new Error(
        `${specPath}: expected exactly one spec, found ${entries.length}`,
      );
    }
    const [hasteModuleName, module] = entries[0];
    if (module.type === 'NativeModule') {
      const generator = new SpecGenerator({
        specPath,
        hasteModuleName,
        module,
      });
      modules.push(
        renderSpec(generator, generator.methods(), generator.events()),
      );
    } else if (module.type === 'Component') {
      for (const [componentName, component] of Object.entries(
        module.components ?? {},
      )) {
        const generator = new ComponentGenerator({
          specPath,
          hasteModuleName,
          componentName,
          component,
        });
        components.push(renderComponent(generator));
        componentsUseImageSource ||= generator.usesImageSource;
      }
    } else {
      throw new Error(
        `${specPath}: expected a NativeModule or a component, found ${module.type}`,
      );
    }
  }
  const header = [
    '// Generated by @react-native-gpui/codegen from TypeScript specs; do not edit.',
    '',
    modules.length > 0 ? MODULE_IMPORTS : null,
    components.length > 0
      ? [
          COMPONENT_IMPORTS,
          componentsUseImageSource ? COMPONENT_IMAGE_SOURCE : '',
          COMPONENT_ABI,
        ]
          .filter(part => part !== '')
          .map(part => part.trimEnd())
          .join('\n')
      : null,
  ]
    .filter(line => line !== null)
    .join('\n');
  const body = [...modules, ...components]
    .map(chunk => chunk.replace(/^\n+/u, '').trimEnd())
    .join('\n');
  return `${header.trimEnd()}\n\n${body}\n`;
}

const MODULE_IMPORTS = `use std::sync::Arc;

use rn_gpui_module::__private::{Args, FieldMap, Path};
use rn_gpui_module::{
    ArrayBuffer, EventEmitter, EventInfo, FromValue, IntoValue, LocalBoxFuture, MethodInfo, MethodKind,
    ModuleDescriptor, ModuleError, ModuleInstance, ModuleThread, Value,
};
`;

function renderSpec(generator, methods, events) {
  const lines = [];
  lines.push(`// ${generator.specPath}`);
  lines.push('');
  lines.push(renderEvents(generator, events));
  lines.push(renderTrait(generator, methods));
  lines.push(renderDescriptor(generator, methods, events));
  lines.push(renderInstance(generator, methods));
  for (const type of generator.types) {
    lines.push(type.kind === 'struct' ? renderStruct(type) : renderEnum(type));
  }
  return lines.filter(line => line !== null).join('\n');
}

function renderEvents(generator, events) {
  const lines = [];
  lines.push('#[derive(Clone)]');
  lines.push(`pub struct ${generator.eventsName} {`);
  lines.push('    emitter: EventEmitter,');
  lines.push('}');
  lines.push('');
  lines.push(`impl ${generator.eventsName} {`);
  for (const event of events) {
    if (event.hasValue) {
      lines.push(`    pub fn ${event.name}(&self, value: ${event.rustType}) {`);
      lines.push(
        `        self.emitter.emit(${JSON.stringify(event.jsName)}, Some(value.into_value()));`,
      );
      lines.push('    }');
    } else {
      lines.push(`    pub fn ${event.name}(&self) {`);
      lines.push(
        `        self.emitter.emit(${JSON.stringify(event.jsName)}, None);`,
      );
      lines.push('    }');
    }
    lines.push('');
  }
  lines.push('    pub fn send_event(&self, name: &str, body: Value) {');
  lines.push('        self.emitter.send_event(name, body);');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function methodSignature(method) {
  const parameters = method.params
    .map(parameter => `${parameter.name}: ${parameter.rustType}`)
    .join(', ');
  switch (method.kind) {
    case 'value':
      return `    fn ${method.name}(&self${parameters ? `, ${parameters}` : ''}) -> Result<${method.rustReturn}, ModuleError>;`;
    case 'void':
      return `    fn ${method.name}(&self${parameters ? `, ${parameters}` : ''});`;
    default:
      return `    async fn ${method.name}(&self${parameters ? `, ${parameters}` : ''}) -> Result<${method.rustReturn}, ModuleError>;`;
  }
}

function renderTrait(generator, methods) {
  const lines = [];
  lines.push('#[allow(async_fn_in_trait)]');
  lines.push(
    `pub trait ${generator.traitName}: Send + Sync + Sized + 'static {`,
  );
  lines.push('    const THREAD: ModuleThread = ModuleThread::Own;');
  lines.push('');
  lines.push(`    fn new(events: ${generator.eventsName}) -> Self;`);
  lines.push('');
  for (const method of methods) {
    lines.push(methodSignature(method));
  }
  lines.push('}');
  return lines.join('\n');
}

function renderDescriptor(generator, methods, events) {
  const lines = [];
  lines.push(
    `pub fn ${generator.descriptorName}<M: ${generator.traitName}>() -> ModuleDescriptor {`,
  );
  lines.push('    ModuleDescriptor {');
  lines.push(`        name: ${JSON.stringify(generator.moduleName)},`);
  lines.push('        thread: M::THREAD,');
  lines.push('        methods: &[');
  for (const method of methods) {
    const kind =
      method.kind === 'value'
        ? 'MethodKind::Value'
        : method.kind === 'void'
          ? 'MethodKind::Void'
          : 'MethodKind::Promise';
    const callbacks = `&[${method.callbackArgs.join(', ')}]`;
    lines.push('            MethodInfo {');
    lines.push(`                name: ${JSON.stringify(method.jsName)},`);
    lines.push(`                arg_count: ${method.params.length},`);
    lines.push(`                required_args: ${method.requiredArgs},`);
    lines.push(`                kind: ${kind},`);
    lines.push(`                returns_void: ${method.returnsVoid},`);
    lines.push(`                callback_args: ${callbacks},`);
    lines.push('            },');
  }
  lines.push('        ],');
  lines.push('        events: &[');
  for (const event of events) {
    lines.push('            EventInfo {');
    lines.push(`                name: ${JSON.stringify(event.jsName)},`);
    lines.push(`                has_value: ${event.hasValue},`);
    lines.push('            },');
  }
  lines.push('        ],');
  lines.push(
    `        create: |events| Arc::new(${generator.instanceName}::<M>::new(events)) as Arc<dyn ModuleInstance>,`,
  );
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

const ARGS_CURSOR = 'arguments_';

function argumentConversion(method, parameter) {
  if (parameter.isCallback) {
    const args = (parameter.annotation.params ?? []).map(
      (callbackArg, index) => `a${index}: ${parameter.callbackArgTypes[index]}`,
    );
    const values = (parameter.annotation.params ?? [])
      .map((_, index) => `a${index}.into_value()`)
      .join(', ');
    return [
      `                let ${parameter.name} = ${ARGS_CURSOR}.next_callback(${JSON.stringify(parameter.jsName)})?;`,
      `                let ${parameter.name}: ${parameter.rustType} =`,
      `                    Box::new(move |${args.join(', ')}| ${parameter.name}.invoke(vec![${values}]));`,
    ];
  }
  return [
    `                let ${parameter.name}: ${parameter.rustType} = ${ARGS_CURSOR}.next(${JSON.stringify(parameter.jsName)})?;`,
  ];
}

function renderInstance(generator, methods) {
  const lines = [];
  lines.push(`struct ${generator.instanceName}<M: ${generator.traitName}>(M);`);
  lines.push('');
  lines.push(`impl<M: ${generator.traitName}> ${generator.instanceName}<M> {`);
  lines.push('    fn new(events: EventEmitter) -> Self {');
  lines.push(
    `        Self(M::new(${generator.eventsName} { emitter: events }))`,
  );
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(
    `impl<M: ${generator.traitName}> ModuleInstance for ${generator.instanceName}<M> {`,
  );
  for (const kind of ['value', 'void', 'promise']) {
    const matching = methods.filter(method => method.kind === kind);
    lines.push(renderCall(generator, kind, matching));
    lines.push('');
  }
  lines.push('}');
  return lines.join('\n');
}

function renderCall(generator, kind, methods) {
  const name = generator.moduleName;
  const lines = [];
  const signature =
    kind === 'promise'
      ? '    fn call_promise(\n        self: Arc<Self>,\n        method: usize,\n        args: Vec<Value>,\n    ) -> Result<LocalBoxFuture<Result<Value, ModuleError>>, ModuleError> {'
      : kind === 'value'
        ? '    fn call_value(&self, method: usize, args: Vec<Value>) -> Result<Value, ModuleError> {'
        : `    fn prepare_void(\n        self: Arc<Self>,\n        method: usize,\n        args: Vec<Value>,\n    ) -> Result<Box<dyn FnOnce() + Send + 'static>, ModuleError> {`;
  lines.push(signature);
  lines.push('        match method {');
  for (const method of methods) {
    lines.push(`            ${method.index} => {`);
    lines.push(
      `                let mut ${ARGS_CURSOR} = Args::new(${JSON.stringify(name)}, ${JSON.stringify(method.jsName)}, args);`,
    );
    for (const parameter of method.params) {
      lines.push(...argumentConversion(method, parameter));
    }
    const call = `self.0.${method.name}(${method.params.map(parameter => parameter.name).join(', ')})`;
    if (kind === 'value') {
      lines.push(
        `                let result = rn_gpui_module::__private::catch(|| ${call})??;`,
      );
      lines.push('                Ok(result.into_value())');
    } else if (kind === 'void') {
      lines.push('                Ok(Box::new(move || {');
      lines.push(
        `                    rn_gpui_module::__private::run_void(${JSON.stringify(`${name}.${method.jsName}`)}, move || ${call});`,
      );
      lines.push('                }))');
    } else {
      lines.push('                Ok(Box::pin(async move {');
      lines.push(
        `                    let result = rn_gpui_module::__private::catch_async(${call}).await??;`,
      );
      lines.push('                    Ok(result.into_value())');
      lines.push('                }))');
    }
    lines.push('            }');
  }
  lines.push(
    `            _ => Err(ModuleError::new(${JSON.stringify(`${name}: unknown method`)}))`,
  );
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

/// `Value` has no `Clone` or `PartialEq`, so a struct that holds one, directly
/// or behind `Option`/`Vec`, derives less.
function isValueType(rustType) {
  const inner = rustType.endsWith('>')
    ? rustType.slice(rustType.indexOf('<') + 1, -1)
    : rustType;
  return inner === 'Value' || (inner !== rustType && isValueType(inner));
}

function renderStruct(struct) {
  const hasValueField = struct.fields.some(field =>
    isValueType(field.rustType),
  );
  const derives = hasValueField
    ? '#[derive(Debug)]'
    : '#[derive(Debug, Clone, PartialEq)]';
  const lines = [];
  lines.push(derives);
  lines.push(`pub struct ${struct.name} {`);
  for (const field of struct.fields) {
    lines.push(`    pub ${field.name}: ${field.rustType},`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`impl FromValue for ${struct.name} {`);
  lines.push(
    '    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {',
  );
  lines.push('        let fields = match value {');
  lines.push('            Value::Object(fields) => fields,');
  lines.push(
    '            other => return Err(path.error(format!("expected object, got {}", other.type_name()))),',
  );
  lines.push('        };');
  lines.push('        let mut fields = FieldMap::new(fields);');
  lines.push(`        Ok(Self {`);
  for (const field of struct.fields) {
    const call = field.optional
      ? `fields.take_optional::<${innerType(field.rustType)}>(path, ${JSON.stringify(field.jsName)})?`
      : `fields.take::<${field.rustType}>(path, ${JSON.stringify(field.jsName)})?`;
    lines.push(`            ${field.name}: ${call},`);
  }
  lines.push('        })');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(`impl IntoValue for ${struct.name} {`);
  lines.push('    fn into_value(self) -> Value {');
  lines.push('        Value::Object(vec![');
  for (const field of struct.fields) {
    lines.push(
      `            (${JSON.stringify(field.jsName)}.to_string(), self.${field.name}.into_value()),`,
    );
  }
  lines.push('        ])');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

const innerType = rustType =>
  rustType.startsWith('Option<') && rustType.endsWith('>')
    ? rustType.slice('Option<'.length, -1)
    : rustType;

function renderEnum(enumType) {
  const lines = [];
  lines.push('#[derive(Debug, Clone, Copy, PartialEq, Eq)]');
  lines.push(`pub enum ${enumType.name} {`);
  for (const member of enumType.members) {
    lines.push(`    ${member.variant},`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`impl FromValue for ${enumType.name} {`);
  lines.push(
    '    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {',
  );
  lines.push('        match value {');
  const expected = enumType.members
    .map(member =>
      enumType.numeric ? String(member.value) : JSON.stringify(member.value),
    )
    .join(', ');
  if (enumType.numeric) {
    lines.push('            Value::Number(number) => match number as i64 {');
    for (const member of enumType.members) {
      lines.push(
        `                ${member.value} => Ok(Self::${member.variant}),`,
      );
    }
    lines.push(
      `                other => Err(path.error(format!(${rustString(`expected one of ${expected}, got {other}`)}))),`,
    );
    lines.push('            },');
  } else {
    lines.push('            Value::String(text) => match text.as_str() {');
    for (const member of enumType.members) {
      lines.push(
        `                ${JSON.stringify(member.value)} => Ok(Self::${member.variant}),`,
      );
    }
    lines.push(
      `                other => Err(path.error(format!(${rustString(`expected one of ${expected}, got "{other}"`)}))),`,
    );
    lines.push('            },');
  }
  lines.push(
    `            other => Err(path.error(format!(${rustString(
      enumType.numeric ? 'expected number, got {}' : 'expected string, got {}',
    )}, other.type_name()))),`,
  );
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(`impl IntoValue for ${enumType.name} {`);
  lines.push('    fn into_value(self) -> Value {');
  lines.push('        match self {');
  for (const member of enumType.members) {
    const value = enumType.numeric
      ? `Value::Number(${member.value} as f64)`
      : `Value::String(${JSON.stringify(member.value)}.to_string())`;
    lines.push(`            Self::${member.variant} => ${value},`);
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

/// The imports a component file needs. A crate that declares a host component
/// renders GPUI content, so it depends on `gpui` and on `react-native-gpui`
/// (for the host context). The module glue needs neither, so each group is
/// emitted only when it is used, and each is allowed to go unused.
const COMPONENT_IMPORTS = `#[allow(unused_imports)]
use gpui::{AnyElement, Window};
#[allow(unused_imports)]
use react_native_gpui::host_component::{
    EmitterHandle, HostArg, HostComponentSpec, HostContext, HostObject, PropsHandle, Value,
};
`;

/// The C ABI between the generated Rust and the generated C++ file, emitted
/// once per generated file that declares a host component.
///
/// Each struct is `#[repr(C)]` with pointer-sized fields in a fixed order, so
/// the C++ side can declare the same three structs and pass them by value; they
/// live once in core's `GpuiHostComponentsCpp.h`, with layout checks:
///
/// ```c
/// struct RnGpuiStr { const uint8_t* data; size_t len; };
/// struct RnGpuiSlice { const void* data; size_t len; };
/// struct RnGpuiOptU32 { uint32_t value; bool present; };
/// ```
///
/// Shims the C++ file implements, so both halves agree on the names:
///
/// * props: `rn_gpui_<component>_props_<prop>`, first argument the opaque props
///   handle a `PropsHandle` owns;
/// * a generated view: `rn_gpui_<view type>_<field>`, first argument the address
///   of that C++ struct;
/// * events: `rn_gpui_<component>_event_<event>`, first argument the opaque
///   emitter handle an `EmitterHandle` owns, then the payload's leaves as
///   arguments (a scalar by value, a string as bytes and a length, an array as a
///   pointer and a length). The C++ shim assigns them into the event struct React
///   Native generated, so the two payload layouts never have to be declared
///   twice.
///
/// The change mask is computed in C++ against the previous shadow view and
/// arrives on the mount op, so there is no shim for it.
///
/// What each returns: `i32` for `Int32` and for an enum's value, `f32` for
/// `Float`, `f64` for `Double`/`number`, `bool` for `boolean`, a `RnGpuiStr`
/// for a `std::string` (bytes plus length), a `RnGpuiOptU32` for a
/// `SharedColor`, the address of the field for an `ImageSource` or a struct,
/// `RnGpuiSlice` for a `std::vector` of plain data, `_len`/`_at` for a
/// `std::vector` of anything else (strings and structs), and, for a
/// `folly::dynamic`, JSON text handed to a callback. No shim allocates except
/// that last one, which serialises once per props object.
const COMPONENT_ABI = `/// A borrowed C++ \`std::string\`: bytes and an explicit length.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RnGpuiStr {
    pub data: *const u8,
    pub len: usize,
}

impl RnGpuiStr {
    /// A string as the event shims take one.
    fn of(text: &str) -> Self {
        Self {
            data: text.as_ptr(),
            len: text.len(),
        }
    }
}

/// A borrowed C++ \`std::vector<T>\` of plain data.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RnGpuiSlice {
    pub data: *const core::ffi::c_void,
    pub len: usize,
}

/// A C++ \`SharedColor\`: \`present\` is false when React left the color unset.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RnGpuiOptU32 {
    pub value: u32,
    pub present: bool,
}

/// The bytes of a \`RnGpuiStr\`, borrowed as a \`&str\`.
///
/// The conversion is checked: a props string came from a JS string, which an
/// engine may hand over with a lone surrogate, and an unchecked conversion of
/// invalid UTF-8 is undefined behaviour in a release build. On failure it logs
/// the offset and returns an empty string rather than reading a different
/// string than the one JS sent.
///
/// # Safety
///
/// \`text\` must have been read from a live C++ \`std::string\` and must outlive
/// the borrow this returns.
unsafe fn rn_gpui_str<'a>(text: RnGpuiStr) -> &'a str {
    if text.data.is_null() || text.len == 0 {
        return "";
    }
    let bytes = core::slice::from_raw_parts(text.data, text.len);
    // Checked, not \`from_utf8_unchecked\`. A release build has no \`debug_assert\`,
    // and \`from_utf8\` is SIMD-fast; on the failure path the offending bytes are
    // reported by offset.
    match core::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            eprintln!(
                "[host-component] a props string is not UTF-8 (valid up to byte {})",
                error.valid_up_to()
            );
            ""
        }
    }
}

/// The elements of a \`RnGpuiSlice\`, borrowed as a \`&[T]\`.
///
/// # Safety
///
/// \`slice\` must point at \`slice.len\` valid, aligned \`T\` values that outlive
/// the borrow this returns.
unsafe fn rn_gpui_slice<'a, T>(slice: RnGpuiSlice) -> &'a [T] {
    if slice.data.is_null() || slice.len == 0 {
        return &[];
    }
    core::slice::from_raw_parts(slice.data.cast::<T>(), slice.len)
}

/// The callback a JSON-text shim hands its bytes to: it appends them to the
/// \`String\` \`context\` points at.
unsafe extern "C" fn rn_gpui_collect_text(
    context: *mut core::ffi::c_void,
    data: *const u8,
    len: usize,
) {
    if data.is_null() || len == 0 {
        return;
    }
    // The one copy a props read can make; counted so a test can assert no other.
    react_native_gpui::host_component::note_props_bytes_copied(len);
    let out = &mut *context.cast::<String>();
    out.push_str(&String::from_utf8_lossy(core::slice::from_raw_parts(data, len)));
}

/// The signature of that callback, as the shims take it.
type RnGpuiTextSink = unsafe extern "C" fn(*mut core::ffi::c_void, *const u8, usize);

/// A borrowed C++ \`std::vector<std::string>\`, read one string at a time.
///
/// The strings in a props struct cannot be lent out as a \`&[&str]\` without
/// allocating, so each one is read on demand through the \`_at\` shim.
#[derive(Clone, Copy)]
pub struct RnGpuiStrArray<'a> {
    owner: *const core::ffi::c_void,
    len: usize,
    at: unsafe extern "C" fn(*const core::ffi::c_void, usize) -> RnGpuiStr,
    _borrow: core::marker::PhantomData<&'a ()>,
}

impl<'a> RnGpuiStrArray<'a> {
    /// # Safety
    ///
    /// \`owner\` must be a live C++ \`std::vector<std::string>\`'s owner that
    /// outlives \`'a\`, \`len\` its length, and \`at\` the shim that reads one
    /// string.
    unsafe fn new(
        owner: *const core::ffi::c_void,
        len: usize,
        at: unsafe extern "C" fn(*const core::ffi::c_void, usize) -> RnGpuiStr,
    ) -> Self {
        Self {
            owner,
            len,
            at,
            _borrow: core::marker::PhantomData,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn get(&self, index: usize) -> Option<&'a str> {
        if index >= self.len {
            return None;
        }
        Some(unsafe { rn_gpui_str((self.at)(self.owner, index)) })
    }

    pub fn iter(&self) -> impl Iterator<Item = &'a str> + '_ {
        (0..self.len).filter_map(move |index| self.get(index))
    }
}
`;

/// React Native's C++ \`ImageSource\`, as a borrowed view. Every component uses
/// the same shape, so it is generated once per file.
const COMPONENT_IMAGE_SOURCE = `/// A borrowed view over React Native's C++ \`ImageSource\`.
#[derive(Clone, Copy)]
pub struct RnGpuiImageSource {
    handle: *const core::ffi::c_void,
}

impl RnGpuiImageSource {
    /// # Safety
    ///
    /// \`handle\` must be the address of a live C++ \`ImageSource\` that outlives
    /// the borrow the accessor returns.
    unsafe fn from_handle(handle: *const core::ffi::c_void) -> Self {
        Self { handle }
    }

    /// The URI; empty when React did not set one.
    pub fn uri(&self) -> &str {
        unsafe { rn_gpui_str(rn_gpui_image_source_uri(self.handle)) }
    }

    /// The bundle name, for an image bundled with the app.
    pub fn bundle(&self) -> &str {
        unsafe { rn_gpui_str(rn_gpui_image_source_bundle(self.handle)) }
    }

    /// The image scale, 3 by default as in React Native.
    pub fn scale(&self) -> f32 {
        unsafe { rn_gpui_image_source_scale(self.handle) }
    }

    /// The intrinsic width.
    pub fn width(&self) -> f32 {
        unsafe { rn_gpui_image_source_width(self.handle) }
    }

    /// The intrinsic height.
    pub fn height(&self) -> f32 {
        unsafe { rn_gpui_image_source_height(self.handle) }
    }

    /// The request body, for a remote image.
    pub fn body(&self) -> &str {
        unsafe { rn_gpui_str(rn_gpui_image_source_body(self.handle)) }
    }

    /// The request method, for a remote image.
    pub fn method(&self) -> &str {
        unsafe { rn_gpui_str(rn_gpui_image_source_method(self.handle)) }
    }
}

unsafe extern "C" {
    fn rn_gpui_image_source_uri(image: *const core::ffi::c_void) -> RnGpuiStr;
    fn rn_gpui_image_source_bundle(image: *const core::ffi::c_void) -> RnGpuiStr;
    fn rn_gpui_image_source_scale(image: *const core::ffi::c_void) -> f32;
    fn rn_gpui_image_source_width(image: *const core::ffi::c_void) -> f32;
    fn rn_gpui_image_source_height(image: *const core::ffi::c_void) -> f32;
    fn rn_gpui_image_source_body(image: *const core::ffi::c_void) -> RnGpuiStr;
    fn rn_gpui_image_source_method(image: *const core::ffi::c_void) -> RnGpuiStr;
}
`;

/// The scalar Rust type of a codegen scalar annotation, or null when the
/// annotation is not a scalar.
function scalarType(annotation) {
  switch (annotation.type) {
    case 'Int32TypeAnnotation':
      return 'i32';
    case 'FloatTypeAnnotation':
      return 'f32';
    case 'DoubleTypeAnnotation':
    case 'NumberTypeAnnotation':
      return 'f64';
    case 'BooleanTypeAnnotation':
      return 'bool';
    default:
      return null;
  }
}

/// The name of an enum member. A string union names its own members, which is
/// also what React Native's C++ enum uses; a numeric enum has no member names in
/// the schema, so the name is built from the prop and the value, exactly as
/// React Native's own generator does (`Rank0` for `0`).
function enumMemberName(value, numeric, index, propName) {
  if (!numeric) return variantName(String(value), index);
  const digits = String(value).replaceAll('-', 'Minus');
  return `${pascal(propName)}${digits}`;
}

/// One component's generated Rust: the layout mirrors, the enums, the views,
/// the props view, the change mask, the events, the context, the trait and the
/// registration value.
export class ComponentGenerator {
  constructor({ specPath, hasteModuleName, componentName, component }) {
    this.specPath = specPath;
    this.hasteModuleName = hasteModuleName;
    this.componentName = componentName;
    this.component = component;
    this.mirrors = [];
    this.enums = [];
    this.views = [];
    this.slices = [];
    this.payloads = [];
    this.typeNames = new Set();
    this.props = [];
    this.events = [];
    this.commands = [];
    this.shims = [];
    this.usesImageSource = false;
  }

  fail(where, detail) {
    throw new Error(`${this.specPath}: ${where}: ${detail}`);
  }

  /// The Fabric component name: what JS mounts and what core registers.
  get name() {
    return this.componentName;
  }

  get propsName() {
    return `${this.name}Props`;
  }

  get changedName() {
    return `${this.name}Changed`;
  }

  get eventsName() {
    return `${this.name}Events`;
  }

  get contextName() {
    return `${this.name}Context`;
  }

  get specName() {
    return `${this.name}Spec`;
  }

  get registrationType() {
    return `${this.name}Component`;
  }

  get registrationFn() {
    return `${snakeCase(this.name)}_component`;
  }

  /// The Rust name for a nested type at `typePath`, e.g. `FixtureChartCardNested`
  /// for the `nested` field of the `card` prop.
  typeNameFor(typePath) {
    return `${this.name}${typePath.map(pascal).join('')}`;
  }

  /// React Native's own C++ name for the struct at `typePath`, so the generated
  /// C++ file can `static_assert` the layouts match.
  cppNameFor(typePath) {
    return `${this.typeNameFor(typePath)}Struct`;
  }

  get changeWords() {
    return Math.max(1, Math.ceil(this.props.length / 64));
  }

  /// A type name nothing else claimed, so two props that would produce the same
  /// name (`points` and `point`) get a suffix rather than colliding.
  claim(base) {
    let name = base;
    let suffix = 2;
    while (this.typeNames.has(name)) {
      name = `${base}${suffix}`;
      suffix += 1;
    }
    this.typeNames.add(name);
    return name;
  }

  /// The Rust enum for a codegen enum annotation, generating it once.
  enumFor(propName, annotation) {
    const numeric = annotation.type === 'Int32EnumTypeAnnotation';
    const options = annotation.options ?? [];
    if (options.length === 0) {
      this.fail(`prop ${propName}`, 'an enum needs at least one member');
    }
    for (const [index, option] of options.entries()) {
      if (numeric && typeof option !== 'number') {
        this.fail(`prop ${propName}`, `enum member ${index} is not a number`);
      }
      if (!numeric && typeof option !== 'string') {
        this.fail(`prop ${propName}`, `enum member ${index} is not a string`);
      }
    }
    const name = this.claim(`${this.name}${pascal(propName)}`);
    const declared = {
      name,
      propName,
      numeric,
      members: options.map((option, index) => ({
        name: enumMemberName(option, numeric, index, propName),
        value: numeric ? option : index,
        text: String(option),
      })),
    };
    this.enums.push(declared);
    return declared;
  }

  /// Whether every leaf of an annotation is plain data, so it can be mirrored
  /// with `#[repr(C)]` and lent out as a slice of structs.
  isPlain(annotation) {
    switch (annotation.type) {
      case 'Int32TypeAnnotation':
      case 'FloatTypeAnnotation':
      case 'DoubleTypeAnnotation':
      case 'NumberTypeAnnotation':
      case 'BooleanTypeAnnotation':
      case 'StringEnumTypeAnnotation':
      case 'Int32EnumTypeAnnotation':
        return true;
      case 'ObjectTypeAnnotation':
        return (annotation.properties ?? []).every(property =>
          this.isPlain(property.typeAnnotation),
        );
      default:
        return false;
    }
  }

  /// A `#[repr(C)]` mirror of a plain object, named after React Native's own
  /// struct for it so the C++ file can assert the two layouts match.
  mirror(typePath, annotation, cppName) {
    const name = this.claim(this.typeNameFor(typePath));
    const fields = (annotation.properties ?? []).map(property => ({
      jsName: property.name,
      name: rustIdentifier(snakeCase(property.name)),
      rustType: this.plainType(property.typeAnnotation, property.name),
    }));
    const mirror = { name, cppName, fields };
    this.mirrors.push(mirror);
    return { kind: 'mirror', name };
  }

  /// The Rust type of a plain-data annotation, inside a mirror or a slice.
  plainType(annotation, propName) {
    const scalar = scalarType(annotation);
    if (scalar) return scalar;
    if (
      annotation.type === 'StringEnumTypeAnnotation' ||
      annotation.type === 'Int32EnumTypeAnnotation'
    ) {
      return this.enumFor(propName, annotation).name;
    }
    if (annotation.type === 'ObjectTypeAnnotation') {
      return this.mirror([propName], annotation, null).name;
    }
    this.fail(
      `prop ${propName}`,
      `unsupported plain-data type ${annotation.type}`,
    );
    return '()';
  }

  /// A view type for an object that holds strings or arrays: its fields are
  /// read one at a time, so it is never mirrored.
  view(typePath, annotation, cppName) {
    const name = this.claim(this.typeNameFor(typePath));
    const view = { name, cppName, fields: [] };
    this.views.push(view);
    view.fields = (annotation.properties ?? []).map(property => ({
      jsName: property.name,
      name: rustIdentifier(snakeCase(property.name)),
      shape: this.shape(property.typeAnnotation, {
        typePath: [...typePath, property.name],
        propName: property.name,
      }),
    }));
    return { kind: 'view', name };
  }

  /// The shape of a props value: what its accessor returns and what the ABI
  /// shim for it carries.
  shape(annotation, { typePath, propName }) {
    const scalar = scalarType(annotation);
    if (scalar) return { kind: 'scalar', rustType: scalar };
    switch (annotation.type) {
      case 'StringTypeAnnotation':
        return { kind: 'string' };
      case 'StringEnumTypeAnnotation':
      case 'Int32EnumTypeAnnotation':
        return {
          kind: 'enum',
          typeName: this.enumFor(propName, annotation).name,
        };
      case 'ReservedPropTypeAnnotation':
        if (annotation.name === 'ColorPrimitive') return { kind: 'color' };
        if (annotation.name === 'ImageSourcePrimitive') {
          this.usesImageSource = true;
          return { kind: 'image' };
        }
        this.fail(
          `prop ${propName}`,
          `unsupported reserved type ${annotation.name}`,
        );
        break;
      case 'MixedTypeAnnotation':
        return { kind: 'mixed' };
      case 'ObjectTypeAnnotation': {
        const cppName = this.cppNameFor(typePath);
        if (this.isPlain(annotation)) {
          return this.mirror(typePath, annotation, cppName);
        }
        return this.view(typePath, annotation, cppName);
      }
      case 'ArrayTypeAnnotation': {
        const element = annotation.elementType;
        if (element.type === 'StringTypeAnnotation') {
          return { kind: 'array-string' };
        }
        const elementScalar = scalarType(element);
        if (elementScalar === 'bool') {
          this.fail(
            `prop ${propName}`,
            'an array of booleans is a bit-packed std::vector<bool> in C++ and cannot be borrowed; use an array of Int32',
          );
        }
        if (elementScalar) {
          return { kind: 'array-scalar', rustType: elementScalar };
        }
        if (element.type === 'ObjectTypeAnnotation') {
          const cppName = this.cppNameFor(typePath);
          if (this.isPlain(element)) {
            return {
              ...this.mirror(typePath, element, cppName),
              kind: 'array-plain',
            };
          }
          const declared = this.view(typePath, element, cppName);
          const slice = { name: `${declared.name}Slice`, view: declared.name };
          this.slices.push(slice);
          return {
            ...declared,
            kind: 'array-view',
            sliceName: slice.name,
          };
        }
        this.fail(
          `prop ${propName}`,
          `unsupported array element ${element.type}; arrays hold scalars, strings or objects`,
        );
        break;
      }
      default:
        this.fail(
          `prop ${propName}`,
          `unsupported component prop type ${annotation.type}`,
        );
        break;
    }
    return { kind: 'scalar', rustType: 'f64' };
  }

  /// The shape of an event payload field. A payload travels Rust to C++ once,
  /// so its fields are owned (`String`, `Vec<T>`) rather than borrowed.
  payloadShape(annotation, { payload, fieldName }) {
    const scalar = scalarType(annotation);
    if (scalar) return { kind: 'scalar', rustType: scalar };
    switch (annotation.type) {
      case 'StringTypeAnnotation':
        return { kind: 'string' };
      case 'StringEnumTypeAnnotation':
      case 'Int32EnumTypeAnnotation':
        return {
          kind: 'enum',
          typeName: this.enumFor(fieldName, annotation).name,
        };
      case 'ObjectTypeAnnotation': {
        const name = this.claim(`${payload}${pascal(fieldName)}`);
        const declared = {
          name,
          label: `The \`${fieldName}\` field inside an event payload.`,
          fields: [],
        };
        this.payloads.push(declared);
        declared.fields = (annotation.properties ?? []).map(property => ({
          jsName: property.name,
          name: rustIdentifier(snakeCase(property.name)),
          shape: this.payloadShape(property.typeAnnotation, {
            payload: name,
            fieldName: property.name,
          }),
        }));
        return { kind: 'object', typeName: name };
      }
      case 'ArrayTypeAnnotation': {
        const element = annotation.elementType;
        if (element.type === 'StringTypeAnnotation') {
          return { kind: 'array-string' };
        }
        const elementScalar = scalarType(element);
        if (elementScalar) {
          return { kind: 'array-scalar', rustType: elementScalar };
        }
        this.fail(
          `event ${payload} field ${fieldName}`,
          `unsupported payload array element ${element.type}; React Native's own parser rejects those too`,
        );
        break;
      }
      default:
        this.fail(
          `event ${payload} field ${fieldName}`,
          `unsupported payload type ${annotation.type}`,
        );
        break;
    }
    return { kind: 'scalar', rustType: 'f64' };
  }

  collect() {
    this.props = (this.component.props ?? []).map((prop, index) => ({
      index,
      jsName: prop.name,
      name: rustIdentifier(snakeCase(prop.name)),
      shape: this.shape(prop.typeAnnotation, {
        typePath: [prop.name],
        propName: prop.name,
      }),
    }));

    this.events = (this.component.events ?? []).map(event => {
      const properties = event.typeAnnotation?.argument?.properties ?? null;
      const name = rustIdentifier(snakeCase(event.name.replace(/^on/u, '')));
      if (properties === null || properties.length === 0) {
        return { jsName: event.name, name, payload: null };
      }
      const payload = {
        name: this.claim(pascal(event.name)),
        label: `The payload of the \`${event.name}\` event.`,
        fields: [],
      };
      this.payloads.push(payload);
      this.activeLabel = payload.label;
      payload.fields = properties.map(property => ({
        jsName: property.name,
        name: rustIdentifier(snakeCase(property.name)),
        shape: this.payloadShape(property.typeAnnotation, {
          payload: payload.name,
          fieldName: property.name,
        }),
      }));
      return { jsName: event.name, name, payload };
    });

    this.commands = (this.component.commands ?? []).map(command => ({
      jsName: command.name,
      name: rustIdentifier(snakeCase(command.name)),
      params: (command.typeAnnotation?.params ?? []).map(parameter => ({
        jsName: parameter.name,
        name: rustIdentifier(snakeCase(parameter.name)),
        rustType: this.commandType(
          parameter.typeAnnotation,
          command.name,
          parameter.name,
        ),
      })),
    }));
  }

  /// A command argument's Rust type. The generated C++ dispatcher converts
  /// `folly::dynamic` arguments to typed values once, so these
  /// are owned.
  commandType(annotation, commandName, parameterName) {
    const scalar = scalarType(annotation);
    if (scalar) return scalar;
    switch (annotation.type) {
      case 'StringTypeAnnotation':
        return 'String';
      case 'ArrayTypeAnnotation': {
        const element = this.commandType(
          annotation.elementType,
          commandName,
          parameterName,
        );
        if (!['i32', 'f32', 'f64', 'bool', 'String'].includes(element)) {
          this.fail(
            `command ${commandName}`,
            `argument "${parameterName}" is an array of ${annotation.elementType.type}; commands take arrays of scalars or strings`,
          );
        }
        return `Vec<${element}>`;
      }
      default:
        this.fail(
          `command ${commandName}`,
          `argument "${parameterName}" has type ${annotation.type}; commands take scalars, strings and arrays of them`,
        );
        break;
    }
    return '()';
  }
}

/// The indentation of an item inside a generated struct or trait.
const INDENT = '    ';
/// The indentation of a statement inside a generated method body.
const BODY = '        ';
const HANDLE = '*const core::ffi::c_void';

/// The width the generated Rust aims for, so a file out of this generator needs
/// no reformatting before it is read or reviewed. It matches rustfmt's default
/// `max_width`.
const WIDTH = 100;

/// A `let Name { field: local, .. } = expression` line, wrapped when long.
function destructureLines(name, bindings, expression, indent = '        ') {
  const oneLine = `let ${name} { ${bindings.join(', ')} } = ${expression};`;
  const pattern = bindings.join(', ');
  if (pattern.length <= 18 && indent.length + oneLine.length <= WIDTH) {
    return [`${indent}${oneLine}`];
  }
  return [
    `${indent}let ${name} {`,
    ...bindings.map(binding => `${indent}    ${binding},`),
    `${indent}} = ${expression};`,
  ];
}

/// A `&[&str]` constant, one entry per line when it would run past [`WIDTH`].
function stringSliceLines(declaration, items, indent = INDENT) {
  const oneLine = `${declaration} &[${items.map(rustString).join(', ')}];`;
  if (indent.length + oneLine.length <= WIDTH) return [`${indent}${oneLine}`];
  return [
    `${indent}${declaration} &[`,
    ...items.map(item => `${indent}    ${rustString(item)},`),
    `${indent}];`,
  ];
}

/// One expression statement at method-body indentation, wrapped inside a block
/// when it would run past [`WIDTH`].
function expressionLines(expression, indent = BODY) {
  if (indent.length + expression.length <= WIDTH) {
    return [`${indent}${expression}`];
  }
  const unsafe = /^unsafe \{ (.*) \}$/u.exec(expression);
  if (unsafe !== null) {
    return [`${indent}unsafe {`, `${indent}    ${unsafe[1]}`, `${indent}}`];
  }
  return [`${indent}{`, `${indent}    ${expression}`, `${indent}}`];
}

/// An `unsafe { shim(..) }` statement, one argument per line when it would run
/// past [`WIDTH`].
function unsafeCallLines(callee, args, indent = BODY) {
  const oneLine = `${indent}unsafe { ${callee}(${args.join(', ')}) }`;
  if (oneLine.length <= WIDTH) return [oneLine];
  return [
    `${indent}unsafe {`,
    ...(args.map(argument => `${indent}    ${argument},`).length > 0
      ? [
          `${indent}    ${callee}(`,
          ...args.map(argument => `${indent}        ${argument},`),
          `${indent}    )`,
        ]
      : [`${indent}    ${callee}()`]),
    `${indent}}`,
  ];
}

/// A declaration, wrapped one parameter per line when it would run long.
function wrapDeclaration(declaration, indent = '    ') {
  if (declaration.length <= 100) return [declaration];
  const open = declaration.indexOf('(');
  const close = declaration.lastIndexOf(')');
  if (open === -1 || close === -1) return [declaration];
  const head = declaration.slice(0, open + 1);
  const body = declaration.slice(open + 1, close);
  const tail = declaration.slice(close);
  const params = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if ('<(['.includes(character)) depth += 1;
    else if ('>)]'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      params.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last.length > 0) params.push(last);
  return [
    head,
    ...params.map(param => `${indent}    ${param},`),
    `${indent}${tail}`,
  ];
}

/// A Rust doc comment block from lines of text.
function docComment(lines, indent = '') {
  return lines.map(line => `${indent}/// ${line}`.trimEnd()).join('\n');
}

/// A doc comment saying what an accessor returns.
function accessorDoc(shape) {
  switch (shape.kind) {
    case 'scalar':
      return `The value, as \`${shape.rustType}\`.`;
    case 'string':
      return 'The string, borrowed from the C++ field.';
    case 'enum':
      return `The enum value, as \`${shape.typeName}\`.`;
    case 'color':
      return 'The ARGB color, or `None` when React left it unset.';
    case 'image':
      return 'A borrowed view over the C++ `ImageSource`.';
    case 'mixed':
      return 'The `UnsafeMixed` value, parsed once on the first read: the one accessor that copies.';
    case 'array-scalar':
      return `The elements, borrowed, as \`&[${shape.rustType}]\`.`;
    case 'array-string':
      return 'The strings, read one at a time.';
    case 'mirror':
      return `The value, as the \`#[repr(C)]\` mirror \`${shape.name}\`.`;
    case 'array-plain':
      return `The elements, borrowed, as \`&[${shape.name}]\`.`;
    case 'view':
      return 'A borrowed view over the C++ struct.';
    case 'array-view':
      return 'The length, then one borrowed view per index.';
    default:
      return '';
  }
}

/// One accessor on a props view or a view type: its body, and the `extern "C"`
/// declaration of the shim it calls.
function accessor({ shimPrefix, shape, name, jsName, owner }) {
  const shim = `${shimPrefix}_${snakeCase(jsName)}`;
  const lines = [];
  const externs = [];
  const call = args => `unsafe { ${shim}(${args}) }`;
  switch (shape.kind) {
    case 'scalar':
      lines.push(`    pub fn ${name}(&self) -> ${shape.rustType} {`);
      lines.push(`        ${call('self.handle')}`);
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> ${shape.rustType};`);
      break;
    case 'string':
      lines.push(`    pub fn ${name}(&self) -> &str {`);
      lines.push(
        ...expressionLines(`unsafe { rn_gpui_str(${shim}(self.handle)) }`),
      );
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> RnGpuiStr;`);
      break;
    case 'enum':
      lines.push(`    pub fn ${name}(&self) -> ${shape.typeName} {`);
      lines.push(`        ${shape.typeName}::from_raw(${call('self.handle')})`);
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> i32;`);
      break;
    case 'color':
      lines.push(`    pub fn ${name}(&self) -> Option<u32> {`);
      lines.push(`        let color = ${call('self.handle')};`);
      lines.push('        if color.present {');
      lines.push('            Some(color.value)');
      lines.push('        } else {');
      lines.push('            None');
      lines.push('        }');
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> RnGpuiOptU32;`);
      break;
    case 'image':
      lines.push(`    pub fn ${name}(&self) -> RnGpuiImageSource {`);
      lines.push(
        ...expressionLines(
          `unsafe { RnGpuiImageSource::from_handle(${shim}(self.handle)) }`,
        ),
      );
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> ${HANDLE};`);
      break;
    case 'mixed':
      lines.push(`    pub fn ${name}(&self) -> &Value {`);
      lines.push(`        self.mixed_${name}.get_or_init(|| {`);
      lines.push('            let mut text = String::new();');
      lines.push('            unsafe {');
      lines.push(`                ${shim}(`);
      lines.push('                    self.handle,');
      lines.push('                    rn_gpui_collect_text,');
      lines.push('                    (&mut text as *mut String).cast(),');
      lines.push('                );');
      lines.push('            }');
      lines.push(
        '            react_native_gpui::host_component::parse_value(&text)',
      );
      lines.push('        })');
      lines.push('    }');
      externs.push(
        `    fn ${shim}(${owner}: ${HANDLE}, sink: RnGpuiTextSink, context: *mut core::ffi::c_void);`,
      );
      break;
    case 'array-scalar':
      lines.push(`    pub fn ${name}(&self) -> &[${shape.rustType}] {`);
      lines.push(`        unsafe { rn_gpui_slice(${shim}(self.handle)) }`);
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> RnGpuiSlice;`);
      break;
    case 'array-string':
      lines.push(`    pub fn ${name}(&self) -> RnGpuiStrArray<'_> {`);
      lines.push(`        let len = unsafe { ${shim}_len(self.handle) };`);
      lines.push(
        `        unsafe { RnGpuiStrArray::new(self.handle, len, ${shim}_at) }`,
      );
      lines.push('    }');
      externs.push(`    fn ${shim}_len(${owner}: ${HANDLE}) -> usize;`);
      externs.push(
        `    fn ${shim}_at(${owner}: ${HANDLE}, index: usize) -> RnGpuiStr;`,
      );
      break;
    case 'mirror':
      lines.push(`    pub fn ${name}(&self) -> ${shape.name} {`);
      lines.push(`        ${call('self.handle')}`);
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> ${shape.name};`);
      break;
    case 'array-plain':
      lines.push(`    pub fn ${name}(&self) -> &[${shape.name}] {`);
      lines.push(`        unsafe { rn_gpui_slice(${shim}(self.handle)) }`);
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> RnGpuiSlice;`);
      break;
    case 'view':
      lines.push(`    pub fn ${name}(&self) -> ${shape.name}<'_> {`);
      lines.push(
        ...expressionLines(
          `unsafe { ${shape.name}::from_handle(${shim}(self.handle)) }`,
        ),
      );
      lines.push('    }');
      externs.push(`    fn ${shim}(${owner}: ${HANDLE}) -> ${HANDLE};`);
      break;
    case 'array-view':
      lines.push(`    pub fn ${name}(&self) -> ${shape.sliceName}<'_> {`);
      lines.push(`        let len = unsafe { ${shim}_len(self.handle) };`);
      lines.push(`        ${shape.sliceName}::new(self.handle, len)`);
      lines.push('    }');
      externs.push(`    fn ${shim}_len(${owner}: ${HANDLE}) -> usize;`);
      externs.push(
        `    fn ${shim}_at(${owner}: ${HANDLE}, index: usize) -> ${HANDLE};`,
      );
      shape.atShim = `${shim}_at`;
      break;
    default:
      throw new Error(
        `generate-rust-spec: unsupported accessor shape ${shape.kind}`,
      );
  }
  return { lines, externs };
}

/// The trait signature of one command.
function commandSignature(command, contextName) {
  const params = command.params
    .map(parameter => `${parameter.name}: ${parameter.rustType}, `)
    .join('');
  return `    fn ${command.name}(&mut self, ${params}cx: &mut ${contextName});`;
}

function renderMirror(mirror) {
  const lines = [];
  lines.push(
    docComment([
      `Layout mirror of the C++ \`${mirror.cppName}\`.`,
      '',
      'Plain data only, so the generated C++ file asserts its size and every',
      'field offset against this struct, and a `std::vector` of them is lent out',
      'as a slice of these.',
    ]),
  );
  lines.push('#[repr(C)]');
  lines.push('#[derive(Clone, Copy, Debug, PartialEq)]');
  lines.push(`pub struct ${mirror.name} {`);
  for (const field of mirror.fields) {
    lines.push(`    /// \`${field.jsName}\``);
    lines.push(`    pub ${field.name}: ${field.rustType},`);
  }
  lines.push('}');
  return lines;
}

function renderComponentEnum(declared) {
  const lines = [];
  lines.push(
    docComment([
      'Mirror of the `enum class` React Native generates for this spec enum.',
      '',
      'The discriminants match the C++ enum, so the value crosses the ABI as an',
      '`i32` and the generated C++ file can assert the two agree.',
    ]),
  );
  lines.push('#[repr(i32)]');
  lines.push('#[derive(Clone, Copy, Debug, PartialEq, Eq)]');
  lines.push(`pub enum ${declared.name} {`);
  for (const member of declared.members) {
    lines.push(`    /// \`${member.text}\``);
    lines.push(`    ${member.name} = ${member.value},`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`impl ${declared.name} {`);
  lines.push('    /// The value the C++ enum holds.');
  lines.push('    pub const fn as_raw(self) -> i32 {');
  lines.push('        self as i32');
  lines.push('    }');
  lines.push('');
  lines.push(
    '    /// The member for a C++ enum value. The C++ side only ever sends a',
  );
  lines.push(
    '    /// declared member, so a mismatch means the two generated halves',
  );
  lines.push(
    '    /// disagree: a debug build trips here, a release build keeps the',
  );
  lines.push(
    '    /// first member rather than reading an invalid discriminant.',
  );
  lines.push('    pub fn from_raw(value: i32) -> Self {');
  lines.push('        match value {');
  for (const member of declared.members) {
    lines.push(`            ${member.value} => Self::${member.name},`);
  }
  lines.push('            other => {');
  lines.push(
    `                debug_assert!(false, "invalid ${declared.name} value {other}");`,
  );
  lines.push(`                Self::${declared.members[0].name}`);
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines;
}

/// The Rust type of an event payload field.
function payloadRustType(shape) {
  switch (shape.kind) {
    case 'scalar':
      return shape.rustType;
    case 'string':
      return 'String';
    case 'enum':
      return shape.typeName;
    case 'object':
      return shape.typeName;
    case 'array-scalar':
      return `Vec<${shape.rustType}>`;
    case 'array-string':
      return 'Vec<String>';
    default:
      return '()';
  }
}

function renderPayload(payload) {
  const lines = [];
  lines.push(
    docComment([
      payload.label,
      '',
      'Owned, because an event travels Rust to C++ once. The shim fills the C++',
      'event struct React Native generated from it, one leaf at a time, rather',
      'than passing this struct across the ABI:',
      '',
      '- a scalar by value, an enum as its `i32`;',
      '- a `String` as a pointer and a length;',
      '- a `Vec` as a pointer and a length, and a `Vec<String>` through a',
      '  temporary `RnGpuiStr` slice.',
    ]),
  );
  lines.push('#[derive(Clone, Debug, PartialEq)]');
  lines.push(`pub struct ${payload.name} {`);
  for (const field of payload.fields) {
    lines.push(`    /// \`${field.jsName}\``);
    lines.push(`    pub ${field.name}: ${payloadRustType(field.shape)},`);
  }
  lines.push('}');
  return lines;
}

/// The lines that flatten an owned payload into shim arguments, the shim's
/// parameter list, and the argument expressions.
function flattenPayload(generator, payload, indent = BODY) {
  const params = [];
  const lines = [];
  const args = [];

  const walkValue = (field, local, argument) => {
    const shape = field.shape;
    switch (shape.kind) {
      case 'scalar':
        params.push(`${argument}: ${shape.rustType}`);
        args.push(local);
        return;
      case 'enum':
        params.push(`${argument}: i32`);
        args.push(`${local}.as_raw()`);
        return;
      case 'string':
        params.push(`${argument}_data: *const u8`);
        params.push(`${argument}_len: usize`);
        args.push(`${local}.as_ptr()`);
        args.push(`${local}.len()`);
        return;
      case 'array-scalar':
        params.push(`${argument}_data: *const ${shape.rustType}`);
        params.push(`${argument}_len: usize`);
        args.push(`${local}.as_ptr()`);
        args.push(`${local}.len()`);
        return;
      case 'array-string': {
        const strings = `__${argument}_strings`;
        const head = `${indent}let ${strings}: Vec<RnGpuiStr> = ${local}`;
        if (
          `${head}.iter().map(|text| RnGpuiStr::of(text)).collect();`.length <=
          WIDTH
        ) {
          lines.push(
            `${head}.iter().map(|text| RnGpuiStr::of(text)).collect();`,
          );
        } else {
          lines.push(head);
          lines.push(`${indent}    .iter()`);
          lines.push(`${indent}    .map(|text| RnGpuiStr::of(text))`);
          lines.push(`${indent}    .collect();`);
        }
        params.push(`${argument}_data: *const RnGpuiStr`);
        params.push(`${argument}_len: usize`);
        args.push(`${strings}.as_ptr()`);
        args.push(`${strings}.len()`);
        return;
      }
      case 'object': {
        const declared = generator.payloads.find(
          candidate => candidate.name === shape.typeName,
        );
        walkObject(declared, local, argument);
        return;
      }
      default:
        throw new Error(
          `generate-rust-spec: unsupported event payload shape ${shape.kind}`,
        );
    }
  };

  const walkObject = (declared, expression, prefix) => {
    const locals = declared.fields.map(
      field => `__${prefix === '' ? '' : `${prefix}_`}${field.name}`,
    );
    lines.push(
      ...destructureLines(
        declared.name,
        declared.fields.map(
          (field, index) => `${field.name}: ${locals[index]}`,
        ),
        expression,
        indent,
      ),
    );
    declared.fields.forEach((field, index) => {
      const argument = prefix === '' ? field.name : `${prefix}_${field.name}`;
      walkValue(field, locals[index], argument);
    });
  };

  walkObject(payload, 'value', '');
  return { params, lines, args };
}

function renderComponentEvents(generator) {
  const lines = [];
  lines.push(
    docComment([
      `The typed events of a \`${generator.name}\` node.`,
      '',
      'An event is queued, not sent: the payload is owned by a closure that',
      "joins the store's one ordered report queue and runs when the store",
      'delivers it. The closure calls the generated `extern "C"` shim for the',
      'event, which fills the C++ event struct React Native generated and hands it',
      'to the generated emitter. The payload crosses as its leaves — a scalar by',
      'value, a string as bytes and a length, an array as a pointer and a length —',
      'so no JSON is built on the way.',
    ]),
  );
  lines.push(`pub struct ${generator.eventsName}<'a> {`);
  lines.push(`    context: &'a mut ${generator.contextName},`);
  lines.push('}');
  lines.push('');
  lines.push(`impl ${generator.eventsName}<'_> {`);
  let first = true;
  for (const event of generator.events) {
    const shim = `rn_gpui_${snakeCase(generator.name)}_event_${snakeCase(event.name)}`;
    if (!first) lines.push('');
    first = false;
    lines.push(`    /// Queues \`${event.jsName}\`.`);
    if (event.payload === null) {
      lines.push(`    pub fn ${event.name}(&mut self) {`);
      lines.push('        let emitter = self.context.emitter.clone();');
      lines.push('        self.context.host.queue_event(move || {');
      lines.push(`            unsafe { ${shim}(emitter.as_ptr()) }`);
      lines.push('        });');
      lines.push('    }');
      generator.shims.push(`    fn ${shim}(emitter: ${HANDLE});`);
      continue;
    }
    const {
      params,
      lines: flatten,
      args,
    } = flattenPayload(generator, event.payload, '            ');
    lines.push(
      `    pub fn ${event.name}(&mut self, value: ${event.payload.name}) {`,
    );
    lines.push('        let emitter = self.context.emitter.clone();');
    lines.push('        self.context.host.queue_event(move || {');
    lines.push(...flatten);
    lines.push(
      ...unsafeCallLines(shim, ['emitter.as_ptr()', ...args], '            '),
    );
    lines.push('        });');
    lines.push('    }');
    generator.shims.push(
      `    fn ${shim}(${['emitter: ' + HANDLE, ...params].join(', ')});`,
    );
  }
  lines.push('}');
  return lines;
}

function renderContext(generator) {
  const lines = [];
  lines.push(
    docComment([
      `What a [\`${generator.specName}\`] method is given: core's host context plus`,
      "the component's typed events.",
      '',
      "Core builds one per call from the node's [`HostContext`] and the event",
      'emitter handle it took at create. What the call reports goes straight',
      "into the store's queue, which delivers it after the batch, the command or",
      'the frame that produced it.',
    ]),
  );
  lines.push(`pub struct ${generator.contextName} {`);
  lines.push('    host: HostContext,');
  lines.push('    emitter: EmitterHandle,');
  lines.push('}');
  lines.push('');
  lines.push(`impl ${generator.contextName} {`);
  lines.push(
    "    /// Core builds one for a call: the node's host context and emitter.",
  );
  lines.push(
    '    pub fn new(host: HostContext, emitter: EmitterHandle) -> Self {',
  );
  lines.push('        Self { host, emitter }');
  lines.push('    }');
  lines.push('');
  lines.push("    /// Core's context: the node's tag and what it reported.");
  lines.push('    pub fn host(&self) -> &HostContext {');
  lines.push('        &self.host');
  lines.push('    }');
  lines.push('');
  lines.push(
    "    /// Core's context, mutably, for a component that reads back what it",
  );
  lines.push('    /// reported in this call.');
  lines.push('    pub fn host_mut(&mut self) -> &mut HostContext {');
  lines.push('        &mut self.host');
  lines.push('    }');
  lines.push('');
  lines.push('    /// The Fabric tag of the node.');
  lines.push('    pub fn tag(&self) -> i32 {');
  lines.push('        self.host.tag');
  lines.push('    }');
  lines.push('');
  lines.push('    /// Reports the size this component wants, in DIPs.');
  lines.push(
    '    pub fn set_intrinsic_size(&mut self, width: f32, height: f32) {',
  );
  lines.push('        self.host.set_intrinsic_size(width, height);');
  lines.push('    }');
  lines.push('');
  lines.push(
    "    /// Reports the padding this container's chrome needs around React's",
  );
  lines.push('    /// children, in DIPs.');
  lines.push(
    '    pub fn set_insets(&mut self, top: f32, right: f32, bottom: f32, left: f32) {',
  );
  lines.push('        self.host.set_insets(top, right, bottom, left);');
  lines.push('    }');
  lines.push('');
  lines.push("    /// The component's typed events.");
  lines.push(`    pub fn events(&mut self) -> ${generator.eventsName}<'_> {`);
  lines.push(`        ${generator.eventsName} { context: self }`);
  lines.push('    }');
  lines.push('}');
  return lines;
}

function renderView(generator, view) {
  const lines = [];
  lines.push(
    docComment([
      `A borrowing view over the C++ \`${view.cppName}\`.`,
      '',
      'Its fields are read one at a time through generated accessors, because a',
      'struct holding a `std::string` or a `std::vector` has no plain layout to',
      'mirror.',
    ]),
  );
  const mixedFields = view.fields.filter(field => field.shape.kind === 'mixed');
  lines.push(`pub struct ${view.name}<'a> {`);
  lines.push(`    handle: ${HANDLE},`);
  lines.push("    _borrow: core::marker::PhantomData<&'a ()>,");
  for (const field of mixedFields) {
    lines.push(`    mixed_${field.name}: std::cell::OnceCell<Value>,`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`impl<'a> ${view.name}<'a> {`);
  lines.push('    /// # Safety');
  lines.push('    ///');
  lines.push(
    `    /// \`handle\` must be the address of a live C++ \`${view.cppName}\` that`,
  );
  lines.push(
    '    /// outlives the borrow the accessor that returned this view gave.',
  );
  lines.push(`    unsafe fn from_handle(handle: ${HANDLE}) -> Self {`);
  lines.push('        Self {');
  lines.push('            handle,');
  lines.push('            _borrow: core::marker::PhantomData,');
  for (const field of mixedFields) {
    lines.push(`            mixed_${field.name}: std::cell::OnceCell::new(),`);
  }
  lines.push('        }');
  lines.push('    }');
  for (const field of view.fields) {
    const rendered = accessor({
      shimPrefix: `rn_gpui_${snakeCase(view.name)}`,
      shape: field.shape,
      name: field.name,
      jsName: field.jsName,
      owner: 'value',
    });
    lines.push('');
    lines.push(`    /// ${accessorDoc(field.shape)}`);
    lines.push(...rendered.lines);
    generator.shims.push(...rendered.externs);
  }
  lines.push('}');
  return lines;
}

function renderSlice(slice, view, atShim) {
  const lines = [];
  lines.push(
    docComment([
      `A borrowed C++ \`std::vector<${view.cppName}>\`:`,
      'the length, then one view per index.',
    ]),
  );
  lines.push(`pub struct ${slice.name}<'a> {`);
  lines.push(`    handle: ${HANDLE},`);
  lines.push('    len: usize,');
  lines.push("    _borrow: core::marker::PhantomData<&'a ()>,");
  lines.push('}');
  lines.push('');
  lines.push(`impl<'a> ${slice.name}<'a> {`);
  lines.push(`    fn new(handle: ${HANDLE}, len: usize) -> Self {`);
  lines.push('        Self {');
  lines.push('            handle,');
  lines.push('            len,');
  lines.push('            _borrow: core::marker::PhantomData,');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    pub fn len(&self) -> usize {');
  lines.push('        self.len');
  lines.push('    }');
  lines.push('');
  lines.push('    pub fn is_empty(&self) -> bool {');
  lines.push('        self.len == 0');
  lines.push('    }');
  lines.push('');
  lines.push(
    `    pub fn get(&self, index: usize) -> Option<${view.name}<'a>> {`,
  );
  lines.push('        if index >= self.len {');
  lines.push('            return None;');
  lines.push('        }');
  lines.push(`        let handle = unsafe { ${atShim}(self.handle, index) };`);
  lines.push('        if handle.is_null() {');
  lines.push('            return None;');
  lines.push('        }');
  lines.push(`        Some(unsafe { ${view.name}::from_handle(handle) })`);
  lines.push('    }');
  lines.push('');
  lines.push(
    `    pub fn iter(&self) -> impl Iterator<Item = ${view.name}<'a>> + '_ {`,
  );
  lines.push('        (0..self.len).filter_map(move |index| self.get(index))');
  lines.push('    }');
  lines.push('}');
  return lines;
}

function renderPropsView(generator) {
  const mixed = generator.props.filter(prop => prop.shape.kind === 'mixed');
  const lines = [];
  lines.push(
    docComment([
      `A typed, borrowing view over the C++ \`${generator.name}Props\`.`,
      '',
      'It wraps the `shared_ptr<const ' +
        generator.name +
        'Props>` the mount op carries, as an',
      'opaque handle. Every accessor reads the C++ field in place, so no prop is',
      'serialised, copied or parsed on the commit path. A borrow lives as long as',
      'the `&self` it came from, so a read cannot outlive the handle.',
      '',
      'A component that keeps data past the call copies what it needs in',
      '`create`/`update` instead of holding the view.',
    ]),
  );
  lines.push(`pub struct ${generator.propsName} {`);
  lines.push(`    handle: ${HANDLE},`);
  for (const prop of mixed) {
    lines.push(`    mixed_${prop.name}: std::cell::OnceCell<Value>,`);
  }
  lines.push('}');
  lines.push('');
  lines.push(`impl ${generator.propsName} {`);
  lines.push('    /// # Safety');
  lines.push('    ///');
  lines.push(
    `    /// \`handle\` must be the node's \`shared_ptr<const ${generator.name}Props>\``,
  );
  lines.push(
    '    /// and must stay alive for as long as the view is used: core holds it',
  );
  lines.push('    /// until the next update replaces it.');
  lines.push(`    pub unsafe fn from_handle(handle: ${HANDLE}) -> Self {`);
  if (mixed.length === 0) {
    lines.push('        Self { handle }');
  } else {
    lines.push('        Self {');
    lines.push('            handle,');
    for (const prop of mixed) {
      lines.push(`            mixed_${prop.name}: std::cell::OnceCell::new(),`);
    }
    lines.push('        }');
  }
  lines.push('    }');
  for (const prop of generator.props) {
    const rendered = accessor({
      shimPrefix: `rn_gpui_${snakeCase(generator.name)}_props`,
      shape: prop.shape,
      name: prop.name,
      jsName: prop.jsName,
      owner: 'props',
    });
    lines.push('');
    lines.push(`    /// ${accessorDoc(prop.shape)}`);
    lines.push(...rendered.lines);
    generator.shims.push(...rendered.externs);
  }
  lines.push('}');
  return lines;
}

function renderChanged(generator) {
  const words = generator.changeWords;
  const lines = [];
  lines.push(
    docComment([
      'Which props changed in an update.',
      '',
      `One bit per prop, in \`${generator.registrationType}::PROPS\` order: bit \`i\` is`,
      'the `i`-th prop, bit 0 of word 0 first. **Up to 64 props fit one `u64`;**',
      'more use one word per 64 (`CHANGE_WORDS` words in all), so 65 props take',
      'two words, 128 take two, 129 take three.',
      '',
      'C++ computes it against the previous shadow view and the mount op carries',
      'the words, so it is always relative to the props this component last saw',
      'and needs no translation.',
    ]),
  );
  lines.push('#[repr(transparent)]');
  lines.push('#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]');
  lines.push(`pub struct ${generator.changedName} {`);
  lines.push(`    words: [u64; ${words}],`);
  lines.push('}');
  lines.push('');
  lines.push(`impl ${generator.changedName} {`);
  lines.push(
    '    /// No prop changed. Core never calls `update` with an empty mask.',
  );
  lines.push('    pub const fn none() -> Self {');
  lines.push(`        Self { words: [0; ${words}] }`);
  lines.push('    }');
  lines.push('');
  lines.push('    /// A mask from the words the C++ comparison wrote.');
  lines.push(`    pub const fn from_words(words: [u64; ${words}]) -> Self {`);
  lines.push('        Self { words }');
  lines.push('    }');
  lines.push('');
  lines.push(
    '    /// A mask from the words the mount op carried. Missing words are zero.',
  );
  lines.push('    pub fn from_slice(words: &[u64]) -> Self {');
  lines.push(`        let mut out = [0u64; ${words}];`);
  lines.push('        for (slot, word) in out.iter_mut().zip(words) {');
  lines.push('            *slot = *word;');
  lines.push('        }');
  lines.push('        Self { words: out }');
  lines.push('    }');
  lines.push('');
  lines.push('    /// The words.');
  lines.push(`    pub const fn words(&self) -> [u64; ${words}] {`);
  lines.push('        self.words');
  lines.push('    }');
  lines.push('');
  lines.push('    /// Whether no prop changed at all.');
  lines.push('    pub fn is_empty(&self) -> bool {');
  lines.push('        self.words.iter().all(|word| *word == 0)');
  lines.push('    }');
  for (const prop of generator.props) {
    const word = Math.floor(prop.index / 64);
    const bit = prop.index % 64;
    lines.push('');
    lines.push(`    /// Whether the \`${prop.jsName}\` prop changed.`);
    lines.push(`    pub const fn ${prop.name}(&self) -> bool {`);
    lines.push(`        self.words[${word}] & (1u64 << ${bit}) != 0`);
    lines.push('    }');
  }
  lines.push('}');
  return lines;
}

function renderSpecTrait(generator) {
  const lines = [];
  lines.push(
    docComment([
      `What a package implements to render a \`${generator.name}\` node.`,
      '',
      'Everything takes `&mut self` and the context rather than an `App`, because',
      'the store is leased while a batch is applied: a component that dispatched',
      'during a call would re-enter it, so the context records what to do and core',
      'applies it when the call returns.',
    ]),
  );
  lines.push(`pub trait ${generator.specName}: Sized + 'static {`);
  lines.push(
    '    /// Created once, when the node mounts, on the main thread, with the',
  );
  lines.push("    /// node's full props.");
  lines.push(
    `    fn create(props: &${generator.propsName}, cx: &mut ${generator.contextName}) -> Self;`,
  );
  lines.push('');
  lines.push("    /// The node's props changed.");
  lines.push('    ///');
  lines.push(
    '    /// Core calls this only when at least one prop changed — never for a',
  );
  lines.push(
    '    /// layout-only, state-only or reparenting update — and `changed` is',
  );
  lines.push('    /// never empty.');
  lines.push('    fn update(');
  lines.push('        &mut self,');
  lines.push(`        props: &${generator.propsName},`);
  lines.push(`        changed: ${generator.changedName},`);
  lines.push(`        cx: &mut ${generator.contextName},`);
  lines.push('    );');
  lines.push('');
  lines.push(
    "    /// The GPUI content, laid out inside the node's Yoga frame.",
  );
  lines.push('    ///');
  lines.push(
    '    /// Must be cheap: read `props` by reference and keep derived data in',
  );
  lines.push(
    "    /// `create`/`update`. Core paints a container's React children itself",
  );
  lines.push('    ///, so they are not passed here.');
  lines.push('    fn render(');
  lines.push('        &mut self,');
  lines.push(`        props: &${generator.propsName},`);
  lines.push('        window: &mut Window,');
  lines.push(`        cx: &mut ${generator.contextName},`);
  lines.push('    ) -> AnyElement;');
  lines.push('');
  lines.push(
    "    /// Content painted above a container's React children (a focus ring, a",
  );
  lines.push('    /// badge), if the component has any.');
  lines.push('    ///');
  lines.push(
    '    /// Core calls this only for a component declared `container: true`.',
  );
  lines.push('    fn render_overlay(');
  lines.push('        &mut self,');
  lines.push(`        props: &${generator.propsName},`);
  lines.push('        window: &mut Window,');
  lines.push(`        cx: &mut ${generator.contextName},`);
  lines.push('    ) -> Option<AnyElement> {');
  lines.push('        let _ = (props, window, cx);');
  lines.push('        None');
  lines.push('    }');
  for (const command of generator.commands) {
    lines.push('');
    lines.push(`    /// JS dispatched the \`${command.jsName}\` command.`);
    lines.push('    ///');
    lines.push(
      '    /// The arguments are already typed: the generated C++ dispatcher',
    );
    lines.push(
      '    /// converted them once, and an unknown command or a wrong argument',
    );
    lines.push('    /// type never reaches here.');
    lines.push(commandSignature(command, generator.contextName));
  }
  lines.push('}');
  return lines;
}

function renderRegistration(generator) {
  const lines = [];
  lines.push(
    docComment([
      `The registration value for [\`${generator.specName}\`].`,
      '',
      `\`react_native_gpui::host_component::register_component(${generator.registrationFn}::<T>())\``,
      'registers `T` for the Fabric component [`NAME`](Self::NAME) before the',
      'first surface starts. The component must be declared under',
      '`platforms.desktop.hostComponents` in `react-native.config.js`: autolink',
      'gives it its registry index and its layout flags from there.',
    ]),
  );
  lines.push(
    `pub struct ${generator.registrationType}<T: ${generator.specName}> {`,
  );
  lines.push('    _spec: core::marker::PhantomData<fn() -> T>,');
  lines.push('}');
  lines.push('');
  lines.push(
    `/// The value \`register_component\` takes for the \`${generator.name}\` component.`,
  );
  lines.push(
    `pub const fn ${generator.registrationFn}<T: ${generator.specName}>() -> ${generator.registrationType}<T> {`,
  );
  lines.push(`    ${generator.registrationType} {`);
  lines.push('        _spec: core::marker::PhantomData,');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(
    `impl<T: ${generator.specName}> ${generator.registrationType}<T> {`,
  );
  lines.push('    /// The Fabric component name the spec declares.');
  lines.push(
    `    pub const NAME: &'static str = ${rustString(generator.name)};`,
  );
  lines.push('');
  lines.push(
    "    /// The spec's own props, in change-mask bit order. `ViewProps` are",
  );
  lines.push("    /// core's, not these.");
  lines.push(
    ...stringSliceLines(
      "pub const PROPS: &'static [&'static str] =",
      generator.props.map(prop => prop.jsName),
    ),
  );
  lines.push('');
  lines.push('    /// How many `u64` words the change mask has.');
  lines.push(`    pub const CHANGE_WORDS: usize = ${generator.changeWords};`);
  lines.push('');
  lines.push('    /// The events the spec declares, in schema order.');
  lines.push(
    ...stringSliceLines(
      "pub const EVENTS: &'static [&'static str] =",
      generator.events.map(event => event.jsName),
    ),
  );
  lines.push('');
  lines.push('    /// The commands the spec declares, in schema order.');
  lines.push(
    ...stringSliceLines(
      "pub const COMMANDS: &'static [&'static str] =",
      generator.commands.map(command => command.jsName),
    ),
  );
  lines.push('}');
  return lines;
}

function renderComponentInstance(generator) {
  const lines = [];
  const instance = `${generator.name}Instance`;
  const spec = generator.specName;
  lines.push(
    docComment([
      `One mounted \`${generator.name}\` node: the user's component, the props`,
      'view built once for the props version it was last given, and the handles',
      'that keep the C++ props and emitter alive.',
      '',
      'Core stores it as a `Box<dyn HostObject>` on the node, so after the node is',
      'created every call is a vtable call and nothing looks the component up.',
    ]),
  );
  lines.push(`struct ${instance}<T: ${spec}> {`);
  lines.push('    component: T,');
  lines.push(`    props: ${generator.propsName},`);
  lines.push(
    '    /// Owns the C++ props `props` reads. Declared after it, so it drops last.',
  );
  lines.push('    #[allow(dead_code)]');
  lines.push('    handle: PropsHandle,');
  lines.push('    emitter: EmitterHandle,');
  lines.push('}');
  lines.push('');
  lines.push(`impl<T: ${spec}> HostObject for ${instance}<T> {`);
  lines.push(
    '    fn update(&mut self, props: PropsHandle, changed: &[u64], cx: HostContext) {',
  );
  lines.push(
    '        // The new view is built once and kept: the `UnsafeMixed` caches in it',
  );
  lines.push('        // then serialise at most once per props version.');
  lines.push(
    `        self.props = unsafe { ${generator.propsName}::from_handle(props.as_ptr()) };`,
  );
  lines.push(
    '        // The previous props are released only now, after the view stopped',
  );
  lines.push('        // pointing at them.');
  lines.push('        self.handle = props;');
  lines.push(
    `        let mut cx = ${generator.contextName}::new(cx, self.emitter.clone());`,
  );
  lines.push(
    `        let changed = ${generator.changedName}::from_slice(changed);`,
  );
  lines.push('        self.component.update(&self.props, changed, &mut cx);');
  lines.push('    }');
  lines.push('');
  lines.push(
    '    fn render(&mut self, window: &mut Window, cx: HostContext) -> AnyElement {',
  );
  lines.push(
    `        let mut cx = ${generator.contextName}::new(cx, self.emitter.clone());`,
  );
  lines.push('        self.component.render(&self.props, window, &mut cx)');
  lines.push('    }');
  lines.push('');
  lines.push(
    '    fn render_overlay(&mut self, window: &mut Window, cx: HostContext) -> Option<AnyElement> {',
  );
  lines.push(
    `        let mut cx = ${generator.contextName}::new(cx, self.emitter.clone());`,
  );
  lines.push(
    '        self.component.render_overlay(&self.props, window, &mut cx)',
  );
  lines.push('    }');
  lines.push('');
  lines.push(
    '    fn command(&mut self, index: u32, args: &[HostArg], cx: HostContext) {',
  );
  if (generator.commands.length === 0) {
    lines.push('        let _ = (index, args, cx);');
  } else {
    lines.push(
      `        let mut cx = ${generator.contextName}::new(cx, self.emitter.clone());`,
    );
    lines.push('        match index {');
    generator.commands.forEach((command, commandIndex) => {
      const values = command.params.map((parameter, position) => {
        const argument = `args[${position}]`;
        return commandArgumentExpression(parameter.rustType, argument);
      });
      const call = `self.component.${command.name}(${[...values, '&mut cx'].join(', ')})`;
      lines.push(`            ${commandIndex} => ${call},`);
    });
    lines.push('            _ => {}');
    lines.push('        }');
  }
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(
    `impl<T: ${spec}> HostComponentSpec for ${generator.registrationType}<T> {`,
  );
  lines.push(`    const NAME: &'static str = ${rustString(generator.name)};`);
  lines.push('');
  lines.push(
    '    fn create(props: PropsHandle, emitter: EmitterHandle, cx: HostContext) -> Box<dyn HostObject> {',
  );
  lines.push(
    `        let view = unsafe { ${generator.propsName}::from_handle(props.as_ptr()) };`,
  );
  lines.push(
    `        let mut cx = ${generator.contextName}::new(cx, emitter.clone());`,
  );
  lines.push('        let component = T::create(&view, &mut cx);');
  lines.push(`        Box::new(${instance} {`);
  lines.push('            component,');
  lines.push('            props: view,');
  lines.push('            handle: props,');
  lines.push('            emitter,');
  lines.push('        })');
  lines.push('    }');
  lines.push('}');
  return lines;
}

/// How a command argument is read from the `HostArg` core hands the instance.
/// The C++ dispatcher validated the type, so the read is infallible.
function commandArgumentExpression(rustType, argument) {
  switch (rustType) {
    case 'i32':
      return `${argument}.to_i32()`;
    case 'f32':
      return `${argument}.to_f32()`;
    case 'f64':
      return `${argument}.to_f64()`;
    case 'bool':
      return `${argument}.to_bool()`;
    case 'String':
      return `${argument}.to_string_value()`;
    case 'Vec<i32>':
      return `${argument}.to_i32_vec()`;
    case 'Vec<f32>':
      return `${argument}.to_f32_vec()`;
    case 'Vec<f64>':
      return `${argument}.to_f64_vec()`;
    case 'Vec<bool>':
      return `${argument}.to_bool_vec()`;
    case 'Vec<String>':
      return `${argument}.to_string_vec()`;
    default:
      throw new Error(
        `generate-rust-spec: unsupported command argument ${rustType}`,
      );
  }
}

/// Renders one component: its types first, then the API over them.
function renderComponent(generator) {
  generator.collect();
  const lines = [];
  lines.push('');
  lines.push(`// ${generator.specPath} — ${generator.name}`);

  for (const mirror of generator.mirrors) {
    lines.push('');
    lines.push(...renderMirror(mirror));
  }
  for (const declared of generator.enums) {
    lines.push('');
    lines.push(...renderComponentEnum(declared));
  }
  for (const payload of generator.payloads) {
    lines.push('');
    lines.push(...renderPayload(payload));
  }
  for (const view of generator.views) {
    lines.push('');
    lines.push(...renderView(generator, view));
  }
  lines.push('');
  lines.push(...renderPropsView(generator));
  const atShims = new Map();
  const recordShim = shape => {
    if (shape.sliceName !== undefined && shape.atShim !== undefined) {
      atShims.set(shape.sliceName, shape.atShim);
    }
  };
  for (const prop of generator.props) recordShim(prop.shape);
  for (const view of generator.views) {
    for (const field of view.fields) recordShim(field.shape);
  }
  for (const slice of generator.slices) {
    const view = generator.views.find(
      candidate => candidate.name === slice.view,
    );
    lines.push('');
    lines.push(...renderSlice(slice, view, atShims.get(slice.name)));
  }
  lines.push('');
  lines.push(...renderChanged(generator));
  lines.push('');
  lines.push(...renderComponentEvents(generator));
  lines.push('');
  lines.push(...renderContext(generator));
  lines.push('');
  lines.push(...renderSpecTrait(generator));
  lines.push('');
  lines.push(...renderRegistration(generator));
  lines.push('');
  lines.push(...renderComponentInstance(generator));
  lines.push('');
  lines.push('// The shims the generated C++ file implements.');
  lines.push(
    '// The ABI comment at the top of this file gives the naming and the shapes.',
  );
  lines.push('#[allow(dead_code, clippy::all)]');
  lines.push('unsafe extern "C" {');
  for (const shim of generator.shims) {
    const declaration = shim.startsWith('    fn ')
      ? shim
      : `    ${shim.trim()}`;
    lines.push(...wrapDeclaration(declaration));
  }
  lines.push('}');
  return lines.join('\n');
}

/// Writes the generated file only when it changed.
export function writeRustSpec({ specPaths, outputPath }) {
  const contents = generateRustSpec({ specPaths });
  const existing = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8')
    : null;
  if (existing !== contents) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, contents);
  }
  return contents;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: generate-rust-spec <spec.ts>... <output.rs>');
    process.exit(2);
  }
  const outputPath = args.at(-1);
  writeRustSpec({ specPaths: args.slice(0, -1), outputPath });
}
