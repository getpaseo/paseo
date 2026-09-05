import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parse } from "@babel/parser";
import type { Plugin } from "esbuild";
import {
  PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
  PLUGIN_SDK_SPECIFIERS,
} from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);
const ESBUILD_BINARY_PATH = "ESBUILD_BINARY_PATH";

// esbuild resolves its own platform binary via require.resolve() the first time its
// module is evaluated. Inside the packaged desktop app that resolves to a path under
// app.asar even though electron-builder unpacks the real binary to app.asar.unpacked.
// child_process.spawn bypasses Electron's asar fs shim, so the OS rejects that path
// with ENOTDIR. Point esbuild at the real unpacked binary before its module loads.
export function unpackedEsbuildBinaryFromPackageDir(
  esbuildPackageDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const asarIndex = esbuildPackageDir.indexOf(asarSegment);
  if (asarIndex === -1) return null;
  return path.join(
    esbuildPackageDir.slice(0, asarIndex),
    "app.asar.unpacked",
    "node_modules",
    `@esbuild/${platform}-${arch}`,
    ...(platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]),
  );
}

export function resolveExistingAsarUnpackedEsbuildBinary(
  esbuildPackageDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const binaryPath = unpackedEsbuildBinaryFromPackageDir(esbuildPackageDir, platform, arch);
  return binaryPath && exists(binaryPath) ? binaryPath : null;
}

function resolveAsarUnpackedEsbuildBinary(): string | null {
  let esbuildDir: string;
  try {
    esbuildDir = path.dirname(nodeRequire.resolve("esbuild/package.json"));
  } catch {
    return null;
  }
  return resolveExistingAsarUnpackedEsbuildBinary(esbuildDir);
}

function loadEsbuild(): typeof import("esbuild") {
  const previousBinaryPath = process.env[ESBUILD_BINARY_PATH];
  const unpackedBinary = resolveAsarUnpackedEsbuildBinary();
  if (unpackedBinary) process.env[ESBUILD_BINARY_PATH] = unpackedBinary;

  try {
    // esbuild reads this variable while its CommonJS module is evaluated. Keep
    // the compatibility bridge local so it cannot become an agent's environment.
    return nodeRequire("esbuild") as typeof import("esbuild");
  } finally {
    if (previousBinaryPath === undefined) delete process.env[ESBUILD_BINARY_PATH];
    else process.env[ESBUILD_BINARY_PATH] = previousBinaryPath;
  }
}

type PluginBuildTarget = "client" | "server";

interface SourceRange {
  start: number;
  end: number;
}

const REGISTRATIONS_REMOVED_BY_TARGET: Record<PluginBuildTarget, ReadonlySet<string>> = {
  client: new Set(["handle", "addTool"]),
  server: new Set([
    "addSurface",
    "addSidebarItem",
    "addWorkspacePanel",
    "addCommandCenterItem",
    "addClientSide",
    "addAttachmentSource",
    "addTheme",
    "addTimelineTransformer",
    "addTimelineRenderer",
  ]),
};

const ALL_PLUGIN_REGISTRATION_METHODS = new Set([
  ...REGISTRATIONS_REMOVED_BY_TARGET.client,
  ...REGISTRATIONS_REMOVED_BY_TARGET.server,
]);

function defaultPluginFunction(programBody: unknown[]): { body: object; contextName: string } {
  const defaultExports = programBody.filter(
    (statement) =>
      statement !== null &&
      typeof statement === "object" &&
      Reflect.get(statement, "type") === "ExportDefaultDeclaration",
  );
  if (defaultExports.length !== 1) {
    throw new Error("Plugin entry point must have exactly one default export function");
  }
  const declaration = Reflect.get(defaultExports[0] as object, "declaration");
  const declarationType =
    declaration !== null && typeof declaration === "object"
      ? Reflect.get(declaration, "type")
      : null;
  if (
    declarationType !== "FunctionDeclaration" &&
    declarationType !== "FunctionExpression" &&
    declarationType !== "ArrowFunctionExpression"
  ) {
    throw new Error("Plugin default export must be a function receiving its context");
  }
  const parameters = Reflect.get(declaration, "params");
  const parameter = Array.isArray(parameters) && parameters.length === 1 ? parameters[0] : null;
  if (
    parameter === null ||
    typeof parameter !== "object" ||
    Reflect.get(parameter, "type") !== "Identifier"
  ) {
    throw new Error("Plugin default export must receive one named context parameter");
  }
  const body = Reflect.get(declaration, "body");
  if (body === null || typeof body !== "object" || Reflect.get(body, "type") !== "BlockStatement") {
    throw new Error("Plugin default export must have a block body");
  }
  return { body, contextName: String(Reflect.get(parameter, "name")) };
}

function astIdentifierName(node: unknown): string | null {
  if (node === null || typeof node !== "object") return null;
  return Reflect.get(node, "type") === "Identifier" ? String(Reflect.get(node, "name")) : null;
}

interface AstScope {
  parent: AstScope | null;
  functionScope: AstScope;
  bindings: Map<string, AstBinding>;
}

interface AstBinding {
  scope: AstScope;
  name: string;
}

function isAstNode(value: unknown): value is object {
  return (
    value !== null && typeof value === "object" && typeof Reflect.get(value, "type") === "string"
  );
}

function isTypeOnlyAstNode(node: object): boolean {
  const type = Reflect.get(node, "type");
  if (typeof type !== "string") return false;
  return (
    type.startsWith("TSType") ||
    type === "TSDeclareFunction" ||
    type === "TSDeclareMethod" ||
    type === "TSInterfaceDeclaration" ||
    type === "TSInterfaceBody" ||
    type === "TSInterfaceHeritage" ||
    type === "TSPropertySignature" ||
    type === "TSMethodSignature" ||
    type === "TSCallSignatureDeclaration" ||
    type === "TSConstructSignatureDeclaration" ||
    type === "TSIndexSignature"
  );
}

function createScope(parent: AstScope | null, functionScope?: AstScope): AstScope {
  const scope = {} as AstScope;
  scope.parent = parent;
  scope.functionScope = functionScope ?? scope;
  scope.bindings = new Map();
  return scope;
}

function lookupBinding(scope: AstScope, name: string): AstBinding | null {
  for (let current: AstScope | null = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return null;
}

function bindIdentifier(
  node: unknown,
  scope: AstScope,
  preserveExisting = false,
): AstBinding | null {
  const name = astIdentifierName(node);
  if (!name) return null;
  if (preserveExisting) {
    const existing = scope.bindings.get(name);
    if (existing) return existing;
  }
  const binding = {
    scope,
    name,
  } satisfies AstBinding;
  scope.bindings.set(name, binding);
  return binding;
}

function declarePattern(pattern: unknown, scope: AstScope, preserveExisting = false): void {
  if (!isAstNode(pattern)) return;
  switch (Reflect.get(pattern, "type")) {
    case "Identifier":
      bindIdentifier(pattern, scope, preserveExisting);
      return;
    case "ObjectPattern": {
      const properties = Reflect.get(pattern, "properties");
      if (!Array.isArray(properties)) return;
      for (const property of properties) {
        if (!isAstNode(property)) continue;
        const type = Reflect.get(property, "type");
        if (type === "ObjectProperty")
          declarePattern(Reflect.get(property, "value"), scope, preserveExisting);
        else if (type === "RestElement")
          declarePattern(Reflect.get(property, "argument"), scope, preserveExisting);
      }
      return;
    }
    case "ArrayPattern": {
      const elements = Reflect.get(pattern, "elements");
      if (Array.isArray(elements))
        for (const element of elements) declarePattern(element, scope, preserveExisting);
      return;
    }
    case "AssignmentPattern":
      declarePattern(Reflect.get(pattern, "left"), scope, preserveExisting);
      return;
    case "RestElement":
    case "TSParameterProperty":
      declarePattern(Reflect.get(pattern, "argument"), scope, preserveExisting);
      return;
  }
}

function declarationScope(scope: AstScope, declarationKind: unknown): AstScope {
  return declarationKind === "var" ? scope.functionScope : scope;
}

function declareDirectBindings(node: unknown, scope: AstScope): void {
  if (!isAstNode(node)) return;
  const type = Reflect.get(node, "type");
  if (type === "VariableDeclaration") {
    if (Reflect.get(node, "declare") === true) return;
    const kind = Reflect.get(node, "kind");
    const declarations = Reflect.get(node, "declarations");
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        if (isAstNode(declaration))
          declarePattern(Reflect.get(declaration, "id"), declarationScope(scope, kind), true);
      }
    }
  } else if (
    (type === "FunctionDeclaration" || type === "ClassDeclaration") &&
    Reflect.get(node, "declare") !== true
  ) {
    bindIdentifier(Reflect.get(node, "id"), scope, true);
  }
}

function predeclareStatements(statements: unknown[], scope: AstScope): void {
  for (const statement of statements) declareDirectBindings(statement, scope);
}

function memberPropertyName(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  const property = Reflect.get(node, "property");
  if (!isAstNode(property)) return null;
  const propertyType = Reflect.get(property, "type");
  if (propertyType === "Identifier" && Reflect.get(node, "computed") !== true) {
    return String(Reflect.get(property, "name"));
  }
  if (propertyType === "StringLiteral" || propertyType === "NumericLiteral") {
    return String(Reflect.get(property, "value"));
  }
  return null;
}

function memberObjectBinding(node: unknown, scope: AstScope): AstBinding | null {
  if (!isAstNode(node)) return null;
  return lookupBinding(scope, String(Reflect.get(node, "name")));
}

function patternContainsBinding(pattern: unknown, name: string): boolean {
  if (!isAstNode(pattern)) return false;
  switch (Reflect.get(pattern, "type")) {
    case "Identifier":
      return Reflect.get(pattern, "name") === name;
    case "ObjectPattern": {
      const properties = Reflect.get(pattern, "properties");
      return (
        Array.isArray(properties) &&
        properties.some((property) => {
          if (!isAstNode(property)) return false;
          const type = Reflect.get(property, "type");
          return type === "ObjectProperty"
            ? patternContainsBinding(Reflect.get(property, "value"), name)
            : type === "RestElement" &&
                patternContainsBinding(Reflect.get(property, "argument"), name);
        })
      );
    }
    case "ArrayPattern": {
      const elements = Reflect.get(pattern, "elements");
      return (
        Array.isArray(elements) && elements.some((element) => patternContainsBinding(element, name))
      );
    }
    case "AssignmentPattern":
      return patternContainsBinding(Reflect.get(pattern, "left"), name);
    case "RestElement":
    case "TSParameterProperty":
      return patternContainsBinding(Reflect.get(pattern, "argument"), name);
    default:
      return false;
  }
}

// oxlint-disable-next-line complexity -- the scoped AST walk strips direct registrations without name-only shadow false positives.
function analyzeRegistrations(
  body: unknown,
  contextName: string,
  removedNames: ReadonlySet<string>,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  const functionScope = createScope(null);
  const contextBinding = bindIdentifier({ type: "Identifier", name: contextName }, functionScope);
  if (!contextBinding)
    throw new Error("Plugin default export must receive one named context parameter");
  const rejectContextBindingMutation = (): never => {
    throw new Error(
      "Plugin default context binding cannot be initialized, reassigned, or redeclared",
    );
  };
  const contributionStatements = isAstNode(body) ? Reflect.get(body, "body") : null;
  const immediateBodyStatements = new Set(
    Array.isArray(contributionStatements) ? contributionStatements.filter(isAstNode) : [],
  );

  const visitStatements = (statements: unknown[], scope: AstScope): void => {
    predeclareStatements(statements, scope);
    for (const statement of statements) visit(statement, scope, null, null);
  };

  const visitPatternInitializers = (pattern: unknown, scope: AstScope): void => {
    if (!isAstNode(pattern)) return;
    const type = Reflect.get(pattern, "type");
    if (type === "AssignmentPattern") {
      visit(Reflect.get(pattern, "right"), scope, pattern, null);
      visitPatternInitializers(Reflect.get(pattern, "left"), scope);
      return;
    }
    if (type === "ObjectPattern") {
      const properties = Reflect.get(pattern, "properties");
      if (!Array.isArray(properties)) return;
      for (const property of properties) {
        if (!isAstNode(property)) continue;
        if (Reflect.get(property, "type") === "ObjectProperty") {
          if (Reflect.get(property, "computed") === true) {
            visit(Reflect.get(property, "key"), scope, property, null);
          }
          visitPatternInitializers(Reflect.get(property, "value"), scope);
        } else if (Reflect.get(property, "type") === "RestElement") {
          visitPatternInitializers(Reflect.get(property, "argument"), scope);
        }
      }
      return;
    }
    if (type === "ArrayPattern") {
      const elements = Reflect.get(pattern, "elements");
      if (Array.isArray(elements)) {
        for (const element of elements) visitPatternInitializers(element, scope);
      }
      return;
    }
    if (type === "RestElement" || type === "TSParameterProperty") {
      visitPatternInitializers(Reflect.get(pattern, "argument"), scope);
    }
  };

  const visitDecorators = (node: unknown, scope: AstScope): void => {
    if (!isAstNode(node)) return;
    const decorators = Reflect.get(node, "decorators");
    if (!Array.isArray(decorators)) return;
    for (const decorator of decorators) {
      if (isAstNode(decorator)) visit(Reflect.get(decorator, "expression"), scope, decorator, null);
    }
  };

  const visitPatternDecorators = (pattern: unknown, scope: AstScope): void => {
    if (!isAstNode(pattern)) return;
    visitDecorators(pattern, scope);
    const type = Reflect.get(pattern, "type");
    if (type === "AssignmentPattern") {
      visitPatternDecorators(Reflect.get(pattern, "left"), scope);
      return;
    }
    if (type === "ObjectPattern") {
      const properties = Reflect.get(pattern, "properties");
      if (Array.isArray(properties)) {
        for (const property of properties) {
          if (!isAstNode(property)) continue;
          visitDecorators(property, scope);
          if (Reflect.get(property, "type") === "ObjectProperty") {
            visitPatternDecorators(Reflect.get(property, "value"), scope);
          } else if (Reflect.get(property, "type") === "RestElement") {
            visitPatternDecorators(Reflect.get(property, "argument"), scope);
          }
        }
      }
      return;
    }
    if (type === "ArrayPattern") {
      const elements = Reflect.get(pattern, "elements");
      if (Array.isArray(elements)) {
        for (const element of elements) visitPatternDecorators(element, scope);
      }
      return;
    }
    if (type === "RestElement" || type === "TSParameterProperty") {
      visitPatternDecorators(Reflect.get(pattern, "argument"), scope);
    }
  };

  const visitArguments = (argumentsList: unknown, scope: AstScope, parent: unknown): void => {
    if (!Array.isArray(argumentsList)) return;
    for (const argument of argumentsList) visit(argument, scope, parent, null);
  };

  const addDirectRegistrationRange = (method: string, statement: unknown): void => {
    if (!removedNames.has(method)) return;
    if (!isAstNode(statement)) {
      throw new Error(
        `Could not locate plugin context ${method} registration in plugin entry point`,
      );
    }
    const start = Reflect.get(statement, "start");
    const end = Reflect.get(statement, "end");
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error(
        `Could not locate plugin context ${method} registration in plugin entry point`,
      );
    }
    ranges.push({ start, end });
  };

  const visitFunction = (node: object, parentScope: AstScope): void => {
    const nextScope = createScope(parentScope, undefined);
    const type = Reflect.get(node, "type");
    if (type === "FunctionDeclaration" || type === "FunctionExpression") {
      bindIdentifier(Reflect.get(node, "id"), nextScope);
    }
    visitDecorators(node, parentScope);
    const params = Reflect.get(node, "params");
    if (Array.isArray(params)) {
      for (const parameter of params) {
        declarePattern(parameter, nextScope);
        visitPatternDecorators(parameter, nextScope);
        visitPatternInitializers(parameter, nextScope);
      }
    }
    const functionBody = Reflect.get(node, "body");
    if (isAstNode(functionBody) && Reflect.get(functionBody, "type") === "BlockStatement") {
      const statements = Reflect.get(functionBody, "body");
      if (Array.isArray(statements)) visitStatements(statements, nextScope);
    } else {
      visit(functionBody, nextScope, node, null);
    }
  };

  const visitMethod = (node: object, parentScope: AstScope): void => {
    const nextScope = createScope(parentScope, undefined);
    visitDecorators(node, parentScope);
    const params = Reflect.get(node, "params");
    if (Array.isArray(params)) {
      for (const parameter of params) {
        declarePattern(parameter, nextScope);
        visitPatternDecorators(parameter, nextScope);
      }
    }
    if (Reflect.get(node, "computed") === true) {
      visit(Reflect.get(node, "key"), parentScope, node, null);
    }
    if (Array.isArray(params)) {
      for (const parameter of params) visitPatternInitializers(parameter, nextScope);
    }
    const methodBody = Reflect.get(node, "body");
    if (isAstNode(methodBody) && Reflect.get(methodBody, "type") === "BlockStatement") {
      const statements = Reflect.get(methodBody, "body");
      if (Array.isArray(statements)) visitStatements(statements, nextScope);
    } else {
      visit(methodBody, nextScope, node, null);
    }
  };

  const visitClass = (node: object, parentScope: AstScope): void => {
    if (Reflect.get(node, "declare") === true) return;
    const classScope = createScope(parentScope, parentScope.functionScope);
    bindIdentifier(Reflect.get(node, "id"), classScope);
    visitDecorators(node, parentScope);
    visit(Reflect.get(node, "superClass"), classScope, node, null);

    const classBody = Reflect.get(node, "body");
    const members = isAstNode(classBody) ? Reflect.get(classBody, "body") : null;
    if (!Array.isArray(members)) return;
    for (const member of members) {
      if (!isAstNode(member)) continue;
      const type = Reflect.get(member, "type");
      if (type === "StaticBlock") {
        const staticScope = createScope(classScope);
        const statements = Reflect.get(member, "body");
        if (Array.isArray(statements)) visitStatements(statements, staticScope);
        continue;
      }
      if (
        type === "ClassMethod" ||
        type === "ClassPrivateMethod" ||
        type === "ObjectMethod" ||
        type === "ObjectPrivateMethod"
      ) {
        visitMethod(member, classScope);
        continue;
      }
      if (isTypeOnlyAstNode(member)) continue;
      visitDecorators(member, parentScope);
      if (Reflect.get(member, "computed") === true) {
        visit(Reflect.get(member, "key"), classScope, member, null);
      }
      visit(Reflect.get(member, "value"), classScope, member, null);
    }
  };

  // oxlint-disable-next-line complexity -- this walk resolves lexical bindings and removes only direct registrations.
  const visit = (
    current: unknown,
    scope: AstScope,
    parent: unknown,
    grandparent: unknown,
  ): void => {
    if (!isAstNode(current)) return;
    const type = Reflect.get(current, "type");
    if (
      type === "TSAsExpression" ||
      type === "TSSatisfiesExpression" ||
      type === "TSTypeAssertion"
    ) {
      visit(Reflect.get(current, "expression"), scope, current, parent);
      return;
    }
    if (type === "TSNonNullExpression") {
      visit(Reflect.get(current, "expression"), scope, current, parent);
      return;
    }
    if (isTypeOnlyAstNode(current)) return;
    if (type === "FunctionDeclaration" || type === "ClassDeclaration") {
      if (
        astIdentifierName(Reflect.get(current, "id")) === contextName &&
        lookupBinding(scope, contextName) === contextBinding
      ) {
        rejectContextBindingMutation();
      }
    }
    if (
      type === "FunctionDeclaration" ||
      type === "FunctionExpression" ||
      type === "ArrowFunctionExpression"
    ) {
      visitFunction(current, scope);
      return;
    }
    if (type === "ClassDeclaration" || type === "ClassExpression") {
      visitClass(current, scope);
      return;
    }
    if (
      type === "ObjectMethod" ||
      type === "ClassMethod" ||
      type === "ObjectPrivateMethod" ||
      type === "ClassPrivateMethod"
    ) {
      visitMethod(current, scope);
      return;
    }
    if (type === "BlockStatement") {
      const blockScope = createScope(scope, scope.functionScope);
      const statements = Reflect.get(current, "body");
      if (Array.isArray(statements)) visitStatements(statements, blockScope);
      return;
    }
    if (type === "CatchClause") {
      const catchScope = createScope(scope, scope.functionScope);
      const parameter = Reflect.get(current, "param");
      if (parameter !== null && parameter !== undefined) {
        declarePattern(parameter, catchScope);
        visitPatternDecorators(parameter, catchScope);
        visitPatternInitializers(parameter, catchScope);
      }
      visit(Reflect.get(current, "body"), catchScope, current, parent);
      return;
    }
    if (type === "ForStatement") {
      const loopScope = createScope(scope, scope.functionScope);
      const initializer = Reflect.get(current, "init");
      if (isAstNode(initializer) && Reflect.get(initializer, "type") === "VariableDeclaration") {
        declareDirectBindings(initializer, loopScope);
      }
      visit(initializer, loopScope, current, parent);
      visit(Reflect.get(current, "test"), loopScope, current, parent);
      visit(Reflect.get(current, "update"), loopScope, current, parent);
      visit(Reflect.get(current, "body"), loopScope, current, parent);
      return;
    }
    if (type === "ForInStatement" || type === "ForOfStatement") {
      const loopScope = createScope(scope, scope.functionScope);
      const left = Reflect.get(current, "left");
      if (isAstNode(left) && Reflect.get(left, "type") === "VariableDeclaration") {
        declareDirectBindings(left, loopScope);
      } else if (
        patternContainsBinding(left, contextName) &&
        lookupBinding(loopScope, contextName) === contextBinding
      ) {
        rejectContextBindingMutation();
      }
      visit(left, loopScope, current, parent);
      visit(Reflect.get(current, "right"), scope, current, parent);
      visit(Reflect.get(current, "body"), loopScope, current, parent);
      return;
    }
    if (type === "SwitchStatement") {
      visit(Reflect.get(current, "discriminant"), scope, current, parent);
      const switchScope = createScope(scope, scope.functionScope);
      const cases = Reflect.get(current, "cases");
      if (Array.isArray(cases)) {
        for (const switchCase of cases) {
          if (!isAstNode(switchCase)) continue;
          const consequent = Reflect.get(switchCase, "consequent");
          if (Array.isArray(consequent)) predeclareStatements(consequent, switchScope);
        }
        for (const switchCase of cases) visit(switchCase, switchScope, current, parent);
      }
      return;
    }
    if (type === "SwitchCase") {
      visit(Reflect.get(current, "test"), scope, current, parent);
      const consequent = Reflect.get(current, "consequent");
      if (Array.isArray(consequent)) {
        for (const statement of consequent) visit(statement, scope, current, parent);
      }
      return;
    }
    if (type === "VariableDeclaration") {
      if (Reflect.get(current, "declare") === true) return;
      const kind = Reflect.get(current, "kind");
      const targetScope = declarationScope(scope, kind);
      const declarations = Reflect.get(current, "declarations");
      if (Array.isArray(declarations)) {
        for (const declaration of declarations) {
          if (
            isAstNode(declaration) &&
            patternContainsBinding(Reflect.get(declaration, "id"), contextName) &&
            lookupBinding(targetScope, contextName) === contextBinding
          ) {
            rejectContextBindingMutation();
          }
          visit(declaration, scope, current, parent);
        }
      }
      return;
    }
    if (type === "VariableDeclarator") {
      visitPatternInitializers(Reflect.get(current, "id"), scope);
      visit(Reflect.get(current, "init"), scope, current, parent);
      return;
    }
    if (type === "AssignmentExpression") {
      const left = Reflect.get(current, "left");
      if (
        patternContainsBinding(left, contextName) &&
        lookupBinding(scope, contextName) === contextBinding
      ) {
        rejectContextBindingMutation();
      }
    }
    if (type === "UpdateExpression") {
      const argumentName = astIdentifierName(Reflect.get(current, "argument"));
      if (argumentName && lookupBinding(scope, argumentName) === contextBinding) {
        rejectContextBindingMutation();
      }
    }
    if (type === "MemberExpression" || type === "OptionalMemberExpression") {
      const source = memberObjectBinding(Reflect.get(current, "object"), scope);
      const method = memberPropertyName(current);
      const directCall =
        parent &&
        isAstNode(parent) &&
        (Reflect.get(parent, "type") === "CallExpression" ||
          Reflect.get(parent, "type") === "OptionalCallExpression") &&
        Reflect.get(parent, "callee") === current &&
        grandparent &&
        isAstNode(grandparent) &&
        Reflect.get(grandparent, "type") === "ExpressionStatement" &&
        immediateBodyStatements.has(grandparent);
      if (source === contextBinding) {
        if (
          directCall &&
          Reflect.get(current, "computed") !== true &&
          method &&
          ALL_PLUGIN_REGISTRATION_METHODS.has(method) &&
          scope.functionScope === functionScope
        ) {
          visitArguments(Reflect.get(parent, "arguments"), scope, parent);
          addDirectRegistrationRange(method, grandparent);
        }
        // Non-direct registrations are intentionally left in the bundle. The
        // runtime context for the opposite target exposes inert methods for
        // these cases, including computed and dynamically generated calls.
        return;
      }
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) for (const child of value) visit(child, scope, current, parent);
      else if (isAstNode(value)) visit(value, scope, current, parent);
    }
  };

  if (Array.isArray(contributionStatements)) {
    visitStatements(contributionStatements, functionScope);
  }
  return ranges;
}

function moduleTarget(specifier: string): PluginBuildTarget | null {
  if (/\.client(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "client";
  if (/\.server(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "server";
  return null;
}

function collectOppositeTargetImportRanges(
  programBody: unknown[],
  target: PluginBuildTarget,
  ranges: SourceRange[],
): void {
  for (const statement of programBody) {
    if (
      statement === null ||
      typeof statement !== "object" ||
      Reflect.get(statement, "type") !== "ImportDeclaration"
    ) {
      continue;
    }
    const source = Reflect.get(statement, "source");
    const specifier =
      source !== null && typeof source === "object" ? Reflect.get(source, "value") : null;
    if (typeof specifier !== "string") continue;
    const importedTarget = moduleTarget(specifier);
    if (importedTarget === null || importedTarget === target) continue;
    const start = Reflect.get(statement, "start");
    const end = Reflect.get(statement, "end");
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error(`Could not locate ${importedTarget}-only import in plugin entry point`);
    }
    ranges.push({ start, end });
  }
}

function filterEntrypoint(source: string, target: PluginBuildTarget): string {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx", "decorators-legacy"],
  });
  const pluginFunction = defaultPluginFunction(ast.program.body);
  const ranges = analyzeRegistrations(
    pluginFunction.body,
    pluginFunction.contextName,
    REGISTRATIONS_REMOVED_BY_TARGET[target],
  );
  collectOppositeTargetImportRanges(ast.program.body, target, ranges);

  let output = source;
  for (const range of ranges.toSorted((left, right) => right.start - left.start)) {
    output = `${output.slice(0, range.start)}${output.slice(range.end)}`;
  }
  return output;
}

function createRuntimeBoundaryPlugin(target: PluginBuildTarget): Plugin {
  return {
    name: `paseo-plugin-${target}-runtime-boundary`,
    setup(buildContext) {
      buildContext.onResolve({ filter: /\.(?:client|server)(?:\.[cm]?[jt]sx?)?$/ }, (args) => {
        const importedTarget = moduleTarget(args.path);
        if (importedTarget === null || importedTarget === target) return null;
        return {
          errors: [
            {
              text: `${importedTarget}-only module cannot be imported into the plugin ${target} bundle: ${args.path}`,
            },
          ],
        };
      });
    },
  };
}

function wrapCommonJsBundle(code: string): string {
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

function makeHermesInteropEager(code: string): string {
  // Hermes evaluates esbuild's lazy CommonJS interop getters from a string with
  // the final loop binding, so every named import can resolve to the last export.
  // Plugin bundles execute once and do not need live bindings from host modules.
  return code.replaceAll("get: () => from[key]", "value: from[key]");
}

function exactSpecifierFilter(specifiers: readonly string[]): RegExp {
  const alternatives = specifiers.map((specifier) =>
    specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(${alternatives.join("|")})$`);
}

function createUnusedPlatformModulePlugin(target: PluginBuildTarget): Plugin {
  const filter =
    target === "server"
      ? exactSpecifierFilter([
          "@tanstack/react-query",
          "react",
          "react/jsx-runtime",
          "react-native",
          ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
        ])
      : /^node:/;
  return {
    name: `paseo-plugin-${target}-unused-platform-modules`,
    setup(buildContext) {
      buildContext.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "paseo-unused-platform-module",
        sideEffects: false,
      }));
      buildContext.onLoad({ filter: /.*/, namespace: "paseo-unused-platform-module" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
}

async function compileTarget(entryPath: string, target: PluginBuildTarget): Promise<string> {
  const { build } = loadEsbuild();
  const source = await readFile(entryPath, "utf8");
  const filteredSource = filterEntrypoint(source, target);
  const result = await build({
    stdin: {
      contents: filteredSource,
      loader: "tsx",
      resolveDir: path.dirname(entryPath),
      sourcefile: entryPath,
    },
    bundle: true,
    format: "cjs",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    // Metro lowers async syntax before Hermes sees app code. Plugin client bundles bypass Metro,
    // so apply the same compatibility transform before the app evaluates them from source.
    supported: target === "client" ? { "async-await": false } : undefined,
    external:
      target === "client"
        ? [
            ...PLUGIN_SDK_SPECIFIERS,
            "@tanstack/react-query",
            "react",
            "react/jsx-runtime",
            "react-native",
            "zod",
          ]
        : [...PLUGIN_SDK_SPECIFIERS, "zod"],
    plugins: [createRuntimeBoundaryPlugin(target), createUnusedPlatformModulePlugin(target)],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`Plugin ${target} compilation produced no output`);
  return wrapCommonJsBundle(makeHermesInteropEager(output));
}

export async function compilePlugin(entryPath: string): Promise<{
  clientBundle: string;
  serverBundle: string;
}> {
  const [clientBundle, serverBundle] = await Promise.all([
    compileTarget(entryPath, "client"),
    compileTarget(entryPath, "server"),
  ]);
  return { clientBundle, serverBundle };
}
