import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { createPluginImportReader } from "./compiler-imports.js";
import type { ImportKind, Metafile, OnResolveResult, Plugin } from "esbuild";
import {
  isPluginClientOnlySdkSpecifier,
  isPluginServerOnlySdkSpecifier,
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
  target: PluginBuildTarget | "shared",
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
  target: PluginBuildTarget | "shared",
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
      const checked = new Set<string>();
      const imports = createPluginImportReader(pluginDirectory);
      function resolvedBoundaryError(
        file: string,
        specifier: string,
        importer: string,
        owner: PluginBuildTarget | "shared",
      ) {
        const location = directoryTarget(file, pluginDirectory);
        if (location === "invalid") {
          if (
            [...linkedDependencyRoots].some(
              (root) => containsPath(root, importer) && containsPath(root, file),
            )
          )
            return null;
          if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
            const root = findDependencyRoot(file, specifier, pluginDirectory);
            if (root) {
              linkedDependencyRoots.add(root);
              return null;
            }
          }
        }
        return moduleBoundaryError(location, owner, file);
      }
      async function resolveImportFiles(
        file: string,
        specifier: string,
        kind: ImportKind,
        typeOnly: boolean,
      ): Promise<Set<string>> {
        const declaration = imports.resolve(specifier, file, kind);
        const dependencyFiles = new Set<string>();
        if (declaration && (typeOnly || /\.d\.[cm]?ts$/.test(declaration)))
          dependencyFiles.add(declaration);
        if (typeOnly && !declaration) {
          throw new Error(`Could not resolve type dependency "${specifier}" imported by ${file}`);
        }
        if (!typeOnly) {
          const resolution = await buildContext.resolve(specifier, {
            importer: file,
            resolveDir: path.dirname(file),
            kind,
          });
          // A normal TS import may also be erased. Validate its declarations;
          // esbuild still rejects missing runtime modules when it emits the import.
          if (resolution.errors.length && dependencyFiles.size === 0)
            throw new Error(resolution.errors.map((error) => error.text).join("\n"));
          if (!resolution.errors.length && !resolution.external && resolution.namespace === "file")
            dependencyFiles.add(resolution.path);
        }
        return dependencyFiles;
      }
      async function checkSourceImports(
        file: string,
        inheritedOwner: PluginBuildTarget | "shared",
      ): Promise<OnResolveResult | null> {
        const owner =
          directoryTarget(file, pluginDirectory) === "shared" ? "shared" : inheritedOwner;
        const key = `${owner}:${file}`;
        if (checked.has(key) || !/\.[cm]?[jt]sx?$/.test(file)) return null;
        checked.add(key);
        for (const { specifier, kind, typeOnly } of imports.read(file)) {
          const error =
            runtimeSpecifierError(specifier, owner, file) ??
            lexicalBoundaryError(specifier, path.dirname(file), pluginDirectory, owner);
          if (error) return error;
          // Host modules have separately enforced SDK boundaries and need no local installation.
          if (
            (PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(specifier) ||
            /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/.test(specifier) ||
            isBuiltin(specifier)
          )
            continue;
          const dependencyFiles = await resolveImportFiles(file, specifier, kind, typeOnly);
          for (const dependencyFile of dependencyFiles) {
            const boundaryError = resolvedBoundaryError(dependencyFile, specifier, file, owner);
            if (boundaryError) return boundaryError;
            const dependencyError = await checkSourceImports(dependencyFile, owner);
            if (dependencyError) return dependencyError;
          }
        }
        return null;
      }
      buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) =>
        checkSourceImports(args.path, target),
      );
      buildContext.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") return null;
        if (args.pluginData === boundaryResolution) return null;
        const owner =
          directoryTarget(args.importer, pluginDirectory) === "shared" ? "shared" : target;
        const specifierError = runtimeSpecifierError(args.path, owner, args.importer);
        if (specifierError) return specifierError;
        const lexicalError = lexicalBoundaryError(
          args.path,
          args.resolveDir,
          pluginDirectory,
          owner,
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
        return resolvedBoundaryError(resolution.path, args.path, args.importer, owner);
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

function runtimeSpecifierError(
  specifier: string,
  target: PluginBuildTarget | "shared",
  importer: string,
): OnResolveResult | null {
  let kind: string | null = null;
  if (specifier === "@getpaseo/plugin/client/host") kind = "host-private";
  else if (
    (specifier === "@getpaseo/plugin" ||
      specifier.startsWith("@getpaseo/plugin/") ||
      specifier === "@paseo/plugin" ||
      specifier.startsWith("@paseo/plugin/")) &&
    !(PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(specifier)
  )
    kind = "Unknown SDK";
  else if (target !== "server" && isBuiltin(specifier)) kind = "Node";
  else if (target !== "server" && isPluginServerOnlySdkSpecifier(specifier)) kind = "server-only";
  else if (
    target !== "client" &&
    (isPluginClientOnlySdkSpecifier(specifier) ||
      /^(react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/.test(
        specifier,
      ))
  )
    kind = "client-only";
  return kind
    ? {
        errors: [
          {
            text: `${kind} module cannot be imported into the plugin ${target} bundle: ${specifier} imported by ${importer}`,
          },
        ],
      }
    : null;
}

function checkSharedDependencies(inputs: Metafile["inputs"], pluginDirectory: string): void {
  const pending = Object.keys(inputs).filter(
    (file) => directoryTarget(path.resolve(file), pluginDirectory) === "shared",
  );
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const dependency of inputs[file]?.imports ?? []) {
      const location = directoryTarget(path.resolve(dependency.path), pluginDirectory);
      const error =
        runtimeSpecifierError(dependency.original ?? dependency.path, "shared", file) ??
        (dependency.external
          ? null
          : moduleBoundaryError(
              location === "invalid" ? null : location,
              "shared",
              dependency.path,
            ));
      if (error?.errors?.length) throw new Error(error.errors[0].text);
      if (!dependency.external) pending.push(dependency.path);
    }
  }
}

async function compileTarget(entryPath: string, target: PluginBuildTarget): Promise<string> {
  const { build } = loadEsbuild();
  const pluginDirectory = path.dirname(entryPath);
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
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
    plugins: [createRuntimeBoundaryPlugin(target, pluginDirectory)],
    metafile: true,
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  checkSharedDependencies(result.metafile.inputs, pluginDirectory);
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
