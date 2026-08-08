import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import { build, type Plugin } from "esbuild";

type PluginBuildTarget = "client" | "server";

const REGISTRATIONS_REMOVED_BY_TARGET: Record<PluginBuildTarget, ReadonlySet<string>> = {
  client: new Set(["handle"]),
  server: new Set(["addSurface", "addSidebarItem"]),
};

function registrationName(statement: unknown, contextName: string): string | null {
  if (!statement || typeof statement !== "object") return null;
  const expression = Reflect.get(statement, "expression");
  if (
    !expression ||
    typeof expression !== "object" ||
    Reflect.get(expression, "type") !== "CallExpression"
  ) {
    return null;
  }
  const callee = Reflect.get(expression, "callee");
  if (!callee || typeof callee !== "object" || Reflect.get(callee, "type") !== "MemberExpression") {
    return null;
  }
  const object = Reflect.get(callee, "object");
  const property = Reflect.get(callee, "property");
  if (
    !object ||
    typeof object !== "object" ||
    Reflect.get(object, "type") !== "Identifier" ||
    Reflect.get(object, "name") !== contextName ||
    !property ||
    typeof property !== "object" ||
    Reflect.get(property, "type") !== "Identifier"
  ) {
    return null;
  }
  return String(Reflect.get(property, "name"));
}

function defaultPluginFunction(programBody: unknown[]): { body: object; contextName: string } {
  const defaultExports = programBody.filter(
    (statement) =>
      statement !== null &&
      typeof statement === "object" &&
      Reflect.get(statement, "type") === "ExportDefaultDeclaration",
  );
  if (defaultExports.length !== 1) {
    throw new Error("Plugin index.tsx must have exactly one default export function");
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

function collectRemovedRegistrationRanges(
  node: unknown,
  contextName: string,
  removedNames: ReadonlySet<string>,
  ranges: Array<{ start: number; end: number }>,
): void {
  if (node === null || typeof node !== "object") return;
  if (Reflect.get(node, "type") === "ExpressionStatement") {
    const name = registrationName(node, contextName);
    if (name && removedNames.has(name)) {
      const start = Reflect.get(node, "start");
      const end = Reflect.get(node, "end");
      if (typeof start !== "number" || typeof end !== "number") {
        throw new Error(`Could not locate plugin context ${name} registration in index.tsx`);
      }
      ranges.push({ start, end });
      return;
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value)
        collectRemovedRegistrationRanges(child, contextName, removedNames, ranges);
    } else if (value !== null && typeof value === "object") {
      collectRemovedRegistrationRanges(value, contextName, removedNames, ranges);
    }
  }
}

function removeOppositeTargetRegistrations(source: string, target: PluginBuildTarget): string {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const pluginFunction = defaultPluginFunction(ast.program.body);
  const ranges: Array<{ start: number; end: number }> = [];
  collectRemovedRegistrationRanges(
    pluginFunction.body,
    pluginFunction.contextName,
    REGISTRATIONS_REMOVED_BY_TARGET[target],
    ranges,
  );

  let output = source;
  for (const range of ranges.toReversed()) {
    output = `${output.slice(0, range.start)}${output.slice(range.end)}`;
  }
  return output;
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

function createUnusedPlatformModulePlugin(target: PluginBuildTarget): Plugin {
  const filter =
    target === "server"
      ? /^(@tanstack\/react-query|react|react\/jsx-runtime|react-native)$/
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
  const source = await readFile(entryPath, "utf8");
  const filteredSource = removeOppositeTargetRegistrations(source, target);
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
    external:
      target === "client"
        ? [
            "@paseo/plugin",
            "@tanstack/react-query",
            "react",
            "react/jsx-runtime",
            "react-native",
            "zod",
          ]
        : ["@paseo/plugin", "zod"],
    plugins: [createUnusedPlatformModulePlugin(target)],
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
