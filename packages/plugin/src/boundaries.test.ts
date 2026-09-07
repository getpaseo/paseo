import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const entries = {
  ".": "shared",
  "./server": "server",
  "./provider": "server",
  "./acp": "server",
  "./client": "client",
  "./host": "client",
  "./react-native": "client",
  "./ui": "client",
} as const;
const uiDependency = /^(react(?:-dom|-native)?|use-sync-external-store)(\/|$)/;
const serverModule = /^(server(?:-contracts)?|provider|acp|lifecycle)(\.js|\/)/;
const clientModule =
  /^(client(?:-contracts|-state)?|host|react-native|ui|paseo-context|rpc-context|runtime-context-bridge)(\.js|\/)/;

function resolveLocal(importer: string, specifier: string): string {
  const base = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, ""));
  const result = [base + ".ts", base + ".tsx"].find(existsSync);
  if (!result) throw new Error(`Cannot resolve ${specifier} from ${importer}`);
  return result;
}

function boundaryViolations(entry: string, runtime: "shared" | "server" | "client"): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    // Includes type imports, re-exports, import types, and literal dynamic imports.
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const { fileName: specifier } of imports) {
      const label = `${path.relative(sourceDirectory, file)} -> ${specifier}`;
      if (specifier.startsWith(".")) {
        const local = resolveLocal(file, specifier);
        const module = path
          .relative(sourceDirectory, local)
          .replace(/\\/g, "/")
          .replace(/\.tsx?$/, ".js");
        if (runtime !== "client" && clientModule.test(module)) violations.push(label);
        if (runtime !== "server" && serverModule.test(module)) violations.push(label);
        pending.push(local);
      } else if (runtime === "shared") {
        if (specifier !== "zod" && specifier !== "@getpaseo/protocol/agent-types")
          violations.push(label);
      } else if (runtime === "server") {
        if (
          uiDependency.test(specifier) ||
          /^@getpaseo\/plugin\/(client|host|react-native|ui)(\/|$)/.test(specifier)
        )
          violations.push(label);
      } else if (
        isBuiltin(specifier) ||
        /^@getpaseo\/plugin\/(server|provider|acp)(\/|$)/.test(specifier)
      ) {
        violations.push(label);
      }
    }
  }
  return violations;
}

describe("plugin SDK import boundaries", () => {
  it("classifies every published entry", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(entries).sort());
  });

  it.each(Object.entries(entries))(
    "%s respects its %s boundary, including type dependencies",
    (specifier, runtime) => {
      const name = specifier === "." ? "index" : specifier.slice(2);
      expect(boundaryViolations(path.join(sourceDirectory, `${name}.ts`), runtime)).toEqual([]);
    },
  );
});
