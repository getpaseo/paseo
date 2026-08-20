import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// electron-builder packs node_modules by walking declared production
// `dependencies` only. A package that imports something it lists as a peer
// dependency resolves fine in this hoisted workspace and then throws
// ERR_MODULE_NOT_FOUND inside app.asar, taking the desktop daemon down at
// startup. That shipped twice from @replit/codemirror-lang-* grammars, which
// are editor extensions published as if they were bare parsers.
//
// This replicates the packer's traversal statically: build the closure of
// declared dependencies reachable from @getpaseo/highlight, walk each package's
// real entry points, and assert every bare specifier they reach lands inside
// the closure.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(packageRoot, "../..");

const builtins = new Set(builtinModules);

interface Manifest {
  dependencies?: Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolvePackageDir(name: string): string | null {
  for (const base of [packageRoot, repoRoot]) {
    const dir = path.join(base, "node_modules", name);
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

function collectClosure(): Map<string, string> {
  const closure = new Map<string, string>();
  const queue = Object.keys(readManifest(packageRoot).dependencies ?? {});

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (closure.has(name)) continue;
    const dir = resolvePackageDir(name);
    expect(dir, `${name} is declared as a dependency but is not installed`).not.toBeNull();
    closure.set(name, dir as string);
    queue.push(...Object.keys(readManifest(dir as string).dependencies ?? {}));
  }

  return closure;
}

/** Every string leaf of an `exports` map is a file the package can be entered through. */
function collectExportTargets(node: unknown, into: string[]): void {
  if (typeof node === "string") {
    into.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectExportTargets(child, into);
  } else if (node && typeof node === "object") {
    for (const child of Object.values(node)) collectExportTargets(child, into);
  }
}

function entryFiles(dir: string, manifest: Manifest): string[] {
  const targets: string[] = [];
  collectExportTargets(manifest.exports, targets);
  if (manifest.main) targets.push(manifest.main);
  if (manifest.module) targets.push(manifest.module);
  if (targets.length === 0) targets.push("index.js");

  return targets
    .filter((target) => !target.includes("*"))
    .map((target) => resolveFile(path.resolve(dir, target)))
    .filter((file): file is string => file !== null);
}

/** Node's file resolution, minus the parts no dependency here relies on. */
function resolveFile(candidate: string): string | null {
  const attempts = [
    candidate,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    path.join(candidate, "index.js"),
  ];
  for (const attempt of attempts) {
    if (fs.existsSync(attempt) && fs.statSync(attempt).isFile()) return attempt;
  }
  return null;
}

// Specifiers never contain whitespace, which keeps `from`/`import` inside
// grammar strings (styleTags keys list keywords) from matching.
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"'\s]+)["']/g;

/** Bare specifiers reachable from a package's entry points, following its own relative imports. */
function reachableImports(dir: string, manifest: Manifest): Map<string, string> {
  const bare = new Map<string, string>();
  const seen = new Set<string>();
  const queue = entryFiles(dir, manifest);

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const target = resolveFile(path.resolve(path.dirname(file), specifier));
        if (target) queue.push(target);
      } else if (!specifier.startsWith("node:") && !builtins.has(specifier)) {
        bare.set(packageNameOf(specifier), path.relative(repoRoot, file));
      }
    }
  }

  return bare;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests import devDependencies, which are never packaged.
      if (entry.name === "__tests__") continue;
      files.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("packaged dependency closure", () => {
  const closure = collectClosure();

  it("resolves every declared dependency", () => {
    expect(closure.size).toBeGreaterThan(0);
  });

  it("imports nothing this package does not declare", () => {
    const undeclared = new Map<string, string>();

    for (const file of collectSourceFiles(path.join(packageRoot, "src"))) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        if (builtins.has(specifier)) continue;
        const name = packageNameOf(specifier);
        if (!closure.has(name)) undeclared.set(name, path.relative(repoRoot, file));
      }
    }

    expect([...undeclared].map(([name, file]) => `${name} (imported by ${file})`)).toEqual([]);
  });

  it.each([...closure.keys()].sort())("%s imports nothing outside the closure", (name) => {
    const dir = closure.get(name) as string;
    const undeclared = [...reachableImports(dir, readManifest(dir))]
      .filter(([specifier]) => specifier !== name && !closure.has(specifier))
      .map(([specifier, file]) => `${specifier} (imported by ${file})`);

    expect(
      undeclared,
      `${name} imports packages it does not declare as dependencies; electron-builder omits those from app.asar`,
    ).toEqual([]);
  });
});
