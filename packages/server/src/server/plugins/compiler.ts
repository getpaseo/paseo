import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { OnResolveResult, Plugin } from "esbuild";
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

type PluginModuleLocation = PluginBuildTarget | "shared" | "invalid";

function directoryTarget(filePath: string, pluginDirectory: string): PluginModuleLocation | null {
  const relative = path.relative(pluginDirectory, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "invalid";
  const segments = relative.split(path.sep);
  if (segments.includes("node_modules")) return null;
  if (segments[0] === "client") return "client";
  if (segments[0] === "server") return "server";
  if (segments[0] === "shared") return "shared";
  if (/^index\.client\.tsx?$/.test(relative)) return "client";
  if (/^index\.server\.tsx?$/.test(relative)) return "server";
  return "invalid";
}

function containsPath(directory: string, filePath: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dependencyName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function findDependencyRoot(
  resolvedPath: string,
  specifier: string,
  pluginDirectory: string,
): string | null {
  const expectedName = dependencyName(specifier);
  let directory = path.dirname(resolvedPath);
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === expectedName) {
        if (containsPath(pluginDirectory, directory) || containsPath(directory, pluginDirectory)) {
          return null;
        }
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function moduleBoundaryError(
  moduleLocation: PluginModuleLocation | null,
  target: PluginBuildTarget,
  filePath: string,
): OnResolveResult | null {
  if (moduleLocation === "invalid") {
    return {
      errors: [{ text: `Plugin modules belong in client/, server/, or shared/: ${filePath}` }],
    };
  }
  if (moduleLocation === null || moduleLocation === "shared" || moduleLocation === target) {
    return null;
  }
  return {
    errors: [
      {
        text: `${moduleLocation}-only module cannot be imported into the plugin ${target} bundle: ${filePath}`,
      },
    ],
  };
}

function lexicalBoundaryError(
  specifier: string,
  resolveDirectory: string,
  pluginDirectory: string,
  target: PluginBuildTarget,
): OnResolveResult | null {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return null;
  const lexicalPath = path.resolve(resolveDirectory, specifier);
  if (!containsPath(pluginDirectory, lexicalPath)) return null;
  return moduleBoundaryError(directoryTarget(lexicalPath, pluginDirectory), target, lexicalPath);
}

function createRuntimeBoundaryPlugin(target: PluginBuildTarget, pluginDirectory: string): Plugin {
  const boundaryResolution = {};
  const linkedDependencyRoots = new Set<string>();
  return {
    name: `paseo-plugin-${target}-runtime-boundary`,
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") return null;
        if (args.pluginData === boundaryResolution) return null;
        const lexicalError = lexicalBoundaryError(
          args.path,
          args.resolveDir,
          pluginDirectory,
          target,
        );
        if (lexicalError) return lexicalError;
        const resolution = await buildContext.resolve(args.path, {
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: boundaryResolution,
          with: args.with,
        });
        if (
          resolution.errors.length > 0 ||
          resolution.external ||
          resolution.namespace !== "file"
        ) {
          return null;
        }
        const resolvedPath = resolution.path;
        const importedTarget = directoryTarget(resolvedPath, pluginDirectory);
        if (importedTarget === "invalid") {
          if (
            [...linkedDependencyRoots].some(
              (root) => containsPath(root, args.importer) && containsPath(root, resolvedPath),
            )
          ) {
            return null;
          }
          if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
            const dependencyRoot = findDependencyRoot(resolvedPath, args.path, pluginDirectory);
            if (dependencyRoot) {
              linkedDependencyRoots.add(dependencyRoot);
              return null;
            }
          }
          return moduleBoundaryError(importedTarget, target, resolvedPath);
        }
        return moduleBoundaryError(importedTarget, target, resolvedPath);
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

function createUnusedPlatformModulePlugin(): Plugin {
  const filter = exactSpecifierFilter([
    "@tanstack/react-query",
    "react",
    "react/jsx-runtime",
    "react-native",
    ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
  ]);
  return {
    name: "paseo-plugin-server-unused-platform-modules",
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

function createClientNodeImportPlugin(): Plugin {
  return {
    name: "paseo-plugin-client-node-imports",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^node:/ }, (args) => ({
        errors: [
          {
            text: `Node module cannot be imported into the plugin client bundle: ${args.path} imported by ${args.importer}`,
          },
        ],
      }));
    },
  };
}

async function compileTarget(entryPath: string, target: PluginBuildTarget): Promise<string> {
  const { build } = loadEsbuild();
  const pluginDirectory = path.dirname(entryPath);
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    jsx: target === "client" ? "automatic" : undefined,
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
    plugins: [
      createRuntimeBoundaryPlugin(target, pluginDirectory),
      ...(target === "client"
        ? [createClientNodeImportPlugin()]
        : [createUnusedPlatformModulePlugin()]),
    ],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`Plugin ${target} compilation produced no output`);
  return wrapCommonJsBundle(makeHermesInteropEager(output));
}

export async function compilePlugin(entryPaths: {
  client: string | null;
  server: string | null;
}): Promise<{
  clientBundle: string | null;
  serverBundle: string | null;
}> {
  const [clientBundle, serverBundle] = await Promise.all([
    entryPaths.client ? compileTarget(entryPaths.client, "client") : null,
    entryPaths.server ? compileTarget(entryPaths.server, "server") : null,
  ]);
  return { clientBundle, serverBundle };
}
