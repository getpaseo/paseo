#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SERVER_ROOT = "packages/server/src/server";
const CORE_SOURCE_ROOTS = [
  "packages/server/src",
  "packages/cli/src",
  "packages/desktop/src",
  "packages/app/src",
];
const IN_REPO_RUNTIME_ROOTS = ["runtimes/fixture"];
const migratedOwners = [
  "/session/files/",
  "/session/git-mutation/",
  "/session/provider/",
  "/session/workspace-git-observer/",
  "/session/workspace-provisioning/",
  "/session/workspace-scripts/",
];
const hostModules = new Set(["child_process", "fs", "fs/promises", "module", "which"]);
const auditedNonliteralServerLoads = new Set([
  "packages/server/src/server/plugins/plugin-process.ts|runtimeRequire|nodeRequire|load",
  "packages/server/src/server/workspace-runtime/command/internal/command-runtime.ts|resolveRuntimeCommand|moduleRequire|resolve",
  "packages/server/src/server/speech/providers/local/sherpa/sherpa-runtime-env.ts|resolveSherpaLoaderEnv|require|resolve",
  "packages/server/src/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.ts|loadWithRequire|requireFn|load",
]);

export async function findWorkspaceBoundaryViolations(repoRoot) {
  const files = [
    ...(
      await Promise.all(CORE_SOURCE_ROOTS.map((root) => collectSources(path.join(repoRoot, root))))
    ).flat(),
    ...(
      await Promise.all(
        IN_REPO_RUNTIME_ROOTS.map((root) => collectSources(path.join(repoRoot, root))),
      )
    ).flat(),
  ];
  const modules = await Promise.all(
    files.map(async (filename) => {
      const source = await readFile(filename, "utf8");
      return { filename, sourceFile: parseSource(filename, source) };
    }),
  );
  const publicOwners = new Set(
    modules
      .filter(({ sourceFile }) => staticSpecifiers(sourceFile).some(isPublicEntryPoint))
      .map(({ filename }) => toRepoPath(repoRoot, filename)),
  );
  const violations = [];
  for (const runtimeRoot of IN_REPO_RUNTIME_ROOTS) {
    const ownedModules = modules.filter(({ filename }) =>
      toRepoPath(repoRoot, filename).startsWith(`${runtimeRoot}/`),
    );
    const duplicateHelper = duplicateWorkspaceHelperViolation(repoRoot, runtimeRoot, ownedModules);
    if (duplicateHelper) violations.push(duplicateHelper);
  }
  for (const module of modules) {
    violations.push(...moduleViolations(repoRoot, module, publicOwners));
  }
  return violations.sort((left, right) =>
    `${left.file}:${left.import}:${left.rule}`.localeCompare(
      `${right.file}:${right.import}:${right.rule}`,
    ),
  );
}

function moduleViolations(repoRoot, { filename, sourceFile }, publicOwners) {
  const importer = toRepoPath(repoRoot, filename);
  const external = IN_REPO_RUNTIME_ROOTS.some((root) => importer.startsWith(`${root}/`));
  const testFile = isTestFile(importer);
  const serverProduction = importer.startsWith(`${SERVER_ROOT}/`) && !testFile;
  const governed =
    external || (!testFile && (ownsMigratedSurface(importer) || publicOwners.has(importer)));
  const violations = [];
  for (const specifier of staticSpecifiers(sourceFile)) {
    if (isExternalRuntimeAccess(importer, specifier)) {
      violations.push(violation(importer, specifier, "server-runtime-access"));
    }
    if (!testFile && isForbiddenInternal(importer, specifier)) {
      violations.push(violation(importer, specifier, "module-entrypoint"));
    }
    if (external && !testFile && isExternalEscape(importer, specifier)) {
      violations.push(violation(importer, specifier, "external-runtime-contract"));
    }
  }
  for (const load of moduleLoads(sourceFile)) {
    violations.push(...loadViolations({ importer, external, governed, serverProduction, load }));
  }
  return violations;
}

function loadViolations({ importer, external, governed, serverProduction, load }) {
  if (load.specifier === null) {
    const audited = isAuditedNonliteralServerLoad(importer, load);
    return external || (serverProduction && !audited)
      ? [violation(importer, "<computed>", "nonliteral-module-load")]
      : [];
  }
  const violations = [];
  if (isExternalRuntimeAccess(importer, load.specifier)) {
    violations.push(violation(importer, load.specifier, "server-runtime-access"));
  }
  if (isForbiddenInternal(importer, load.specifier)) {
    violations.push(violation(importer, load.specifier, "module-entrypoint"));
  }
  if (governed && !external && isHostCapability(load.specifier)) {
    violations.push(violation(importer, load.specifier, "workspace-host-access"));
  }
  if (external && isExternalEscape(importer, load.specifier)) {
    violations.push(violation(importer, load.specifier, "external-runtime-contract"));
  }
  return violations;
}

function implementsWorkspaceHelper(source) {
  return ["fs-stat", "fs-list", "fs-read", "fs-write"].every((command) => source.includes(command));
}

function duplicateWorkspaceHelperViolation(repoRoot, runtimeRoot, modules) {
  const combinedSource = modules.map(({ sourceFile }) => sourceFile.text).join("\n");
  if (!implementsWorkspaceHelper(combinedSource)) return null;
  const singleFileOwner = modules.find(({ sourceFile }) =>
    implementsWorkspaceHelper(sourceFile.text),
  );
  const owner = singleFileOwner ? toRepoPath(repoRoot, singleFileOwner.filename) : runtimeRoot;
  return violation(owner, "workspace-helper protocol", "duplicate-workspace-helper");
}

function parseSource(filename, source) {
  return ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function staticSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function moduleLoads(sourceFile) {
  const loads = [];
  const loaderAliases = moduleLoaderAliases(sourceFile);
  visit(sourceFile);
  return loads;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const load = moduleLoad(node.expression, loaderAliases);
      if (!load) {
        ts.forEachChild(node, visit);
        return;
      }
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      loads.push({
        ...load,
        owner: enclosingFunctionName(node),
        specifier: argument ? literalModuleSpecifier(argument) : null,
      });
    }
    ts.forEachChild(node, visit);
  }
}

function moduleLoaderAliases(sourceFile) {
  const aliases = new Set(["require"]);
  const declarations = variableDeclarations(sourceFile);
  const moduleObjects = moduleObjectAliases(sourceFile, declarations);
  const factories = createRequireAliases(sourceFile, declarations, moduleObjects);
  collectNodeRequireParameters(sourceFile, aliases);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const aliasesLoader =
        ts.isIdentifier(declaration.initializer) && aliases.has(declaration.initializer.text);
      const createsLoader = isCreateRequireCall(declaration.initializer, factories, moduleObjects);
      if ((aliasesLoader || createsLoader) && !aliases.has(declaration.name.text)) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function isCreateRequireCall(expression, factories, moduleObjects) {
  if (!ts.isCallExpression(expression)) return false;
  return (
    (ts.isIdentifier(expression.expression) && factories.has(expression.expression.text)) ||
    isCreateRequireProperty(expression.expression, moduleObjects)
  );
}

function variableDeclarations(sourceFile) {
  const declarations = [];
  visit(sourceFile);
  return declarations;

  function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  }
}

function literalModuleSpecifier(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function moduleLoad(expression, loaderAliases) {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { loader: "import", operation: "import" };
  }
  if (ts.isIdentifier(expression) && loaderAliases.has(expression.text)) {
    return { loader: expression.text, operation: "load" };
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    loaderAliases.has(expression.expression.text) &&
    expression.name.text === "resolve"
  ) {
    return { loader: expression.expression.text, operation: "resolve" };
  }
  return null;
}

function createRequireAliases(sourceFile, declarations, moduleObjects) {
  const aliases = importedCreateRequireAliases(sourceFile);
  let changed = true;
  while (changed) {
    changed = addCreateRequireAliases(aliases, moduleObjects, declarations);
  }
  return aliases;
}

function importedCreateRequireAliases(sourceFile) {
  const aliases = new Set();
  for (const statement of sourceFile.statements) {
    if (!isNamedModuleImport(statement)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === "createRequire") {
        aliases.add(element.name.text);
      }
    }
  }
  return aliases;
}

function addCreateRequireAliases(aliases, moduleObjects, declarations) {
  let changed = false;
  for (const declaration of declarations) {
    for (const alias of createRequireBindingNames(declaration, aliases, moduleObjects)) {
      if (aliases.has(alias)) continue;
      aliases.add(alias);
      changed = true;
    }
  }
  return changed;
}

function createRequireBindingNames(declaration, aliases, moduleObjects) {
  if (!declaration.initializer) return [];
  if (ts.isIdentifier(declaration.name)) {
    const initializer = declaration.initializer;
    const factory =
      (ts.isIdentifier(initializer) && aliases.has(initializer.text)) ||
      isCreateRequireProperty(initializer, moduleObjects);
    return factory ? [declaration.name.text] : [];
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return [];
  if (!isModuleObjectExpression(declaration.initializer, moduleObjects)) return [];
  return declaration.name.elements
    .filter(
      (element) =>
        ts.isIdentifier(element.name) && bindingPropertyName(element) === "createRequire",
    )
    .map((element) => element.name.text);
}

function isNamedModuleImport(statement) {
  return (
    ts.isImportDeclaration(statement) &&
    statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    ["module", "node:module"].includes(statement.moduleSpecifier.text)
  );
}

function moduleObjectAliases(sourceFile, declarations) {
  const aliases = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamespaceImport(statement.importClause.namedBindings) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ["module", "node:module"].includes(statement.moduleSpecifier.text)
    ) {
      aliases.add(statement.importClause.namedBindings.name.text);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (
        !isModuleObjectExpression(declaration.initializer, aliases) ||
        aliases.has(declaration.name.text)
      ) {
        continue;
      }
      aliases.add(declaration.name.text);
      changed = true;
    }
  }
  return aliases;
}

function isCreateRequireProperty(expression, moduleObjects) {
  return (
    staticPropertyName(expression) === "createRequire" &&
    isModuleObjectExpression(expression.expression, moduleObjects)
  );
}

function isModuleObjectExpression(expression, moduleObjects) {
  return (
    (ts.isIdentifier(expression) && moduleObjects.has(expression.text)) ||
    isModuleRequireCall(expression)
  );
}

function staticPropertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return literalModuleSpecifier(expression.argumentExpression);
  }
  return null;
}

function bindingPropertyName(element) {
  const property = element.propertyName ?? element.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  if (ts.isComputedPropertyName(property)) return literalModuleSpecifier(property.expression);
  return null;
}

function isModuleRequireCall(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    ["module", "node:module"].includes(expression.arguments[0].text)
  );
}

function collectNodeRequireParameters(sourceFile, aliases) {
  visit(sourceFile);
  function visit(node) {
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type?.getText() === "NodeRequire"
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return "<module>";
}

function isAuditedNonliteralServerLoad(importer, load) {
  return auditedNonliteralServerLoads.has(
    [importer, load.owner, load.loader, load.operation].join("|"),
  );
}

function isPublicEntryPoint(specifier) {
  return /workspace-(?:runtime|helper)\/index\.(?:js|ts)$/.test(specifier);
}

function ownsMigratedSurface(importer) {
  return !isTestFile(importer) && migratedOwners.some((owner) => importer.includes(owner));
}

function isHostCapability(specifier) {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return (
    hostModules.has(normalized) || /(?:^|\/)utils\/run-git-command\.(?:js|ts)$/.test(normalized)
  );
}

function isForbiddenInternal(importer, specifier) {
  const target = resolveSpecifier(importer, specifier);
  if (!target || !target.includes("/internal/")) return false;
  if (target.includes("/provider-probe/internal/")) {
    return !(
      importer.endsWith("/provider-probe/index.ts") ||
      importer.includes("/provider-probe/internal/")
    );
  }
  if (target.includes("/workspace-runtime/command/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/command/index.ts") ||
      importer.includes("/workspace-runtime/command/internal/")
    );
  }
  if (target.includes("/workspace-runtime/git-observation/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/git-observation/index.ts") ||
      importer.includes("/workspace-runtime/git-observation/internal/") ||
      importer.endsWith("/workspace-runtime/internal/service.ts")
    );
  }
  if (target.includes("/workspace-runtime/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/index.ts") ||
      importer.includes("/workspace-runtime/internal/")
    );
  }
  if (target.includes("/workspace-helper/internal/")) {
    return true;
  }
  return false;
}

function isExternalEscape(importer, specifier) {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (normalized === "module") return true;
  if (specifier.startsWith("node:") || hostModules.has(specifier) || specifier === "node-pty") {
    return false;
  }
  if (
    specifier === "@getpaseo/workspace-runtime-contract" ||
    specifier === "@getpaseo/workspace-helper"
  )
    return false;
  if (path.posix.isAbsolute(specifier) || specifier.startsWith("file:")) return true;
  if (specifier.startsWith(".")) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    const owner = IN_REPO_RUNTIME_ROOTS.find((root) => importer.startsWith(`${root}/`));
    return !owner || !target.startsWith(`${owner}/`);
  }
  return (
    specifier === "@getpaseo/server" ||
    specifier.startsWith("@getpaseo/server/") ||
    specifier.includes("packages/server/") ||
    specifier.includes("/internal/")
  );
}

function isExternalRuntimeAccess(importer, specifier) {
  if (!CORE_SOURCE_ROOTS.some((root) => importer.startsWith(`${root}/`))) return false;
  if (/^@getpaseo\/(?:docker|fixture|srt)-workspace-runtime(?:\/|$)/u.test(specifier)) {
    return true;
  }
  if (/paseo-workspace-runtime-(?:docker|srt)|runtimes\/(?:docker|srt)(?:\/|$)/u.test(specifier)) {
    return true;
  }
  const target = resolveSpecifier(importer, specifier);
  return IN_REPO_RUNTIME_ROOTS.some(
    (runtimeRoot) => target === runtimeRoot || target.startsWith(`${runtimeRoot}/`),
  );
}

function resolveSpecifier(importer, specifier) {
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  return specifier.replace(/^@getpaseo\/server\/?/, `${SERVER_ROOT}/`);
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.[^.]+$/.test(filename);
}

function violation(file, imported, rule) {
  return {
    file,
    import: imported,
    rule,
    message: `${file}: ${rule} forbids ${imported}`,
  };
}

async function collectSources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSources(target);
      return [".js", ".mjs", ".ts", ".tsx"].includes(path.extname(entry.name)) ? [target] : [];
    }),
  );
  return nested.flat();
}

function toRepoPath(repoRoot, filename) {
  return path.relative(repoRoot, filename).split(path.sep).join("/");
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await findWorkspaceBoundaryViolations(repoRoot);
  for (const item of violations) process.stderr.write(`${item.message}\n`);
  if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
