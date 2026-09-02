import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "./server.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const forbiddenSpecifiers = new Set([
  "react",
  "react/jsx-runtime",
  "react-native",
  "use-sync-external-store",
  "use-sync-external-store/shim/with-selector",
]);

function localFile(fromFile: string, specifier: string): string {
  const withoutJs = specifier.replace(/\.js$/, "");
  for (const candidate of [`${withoutJs}.ts`, `${withoutJs}.tsx`, withoutJs]) {
    const resolved = path.resolve(path.dirname(fromFile), candidate);
    if (existsSync(resolved)) return resolved;
  }
  throw new Error(`Could not resolve ${specifier} from ${fromFile}`);
}

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)(?:export|import)\s+(?!type\b)(?:[\s\S]*?)from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function collectBareSpecifiers(entry: string): string[] {
  const seen = new Set<string>();
  const bare: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueImportSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(localFile(file, specifier));
        continue;
      }
      bare.push(specifier);
    }
  }
  return bare;
}

describe("@getpaseo/plugin/server", () => {
  it("does not load react or the client hook graph", () => {
    const specifiers = collectBareSpecifiers(path.join(srcDir, "server.ts"));
    expect(specifiers.filter((specifier) => forbiddenSpecifiers.has(specifier))).toEqual([]);
  });

  it("keeps the model-facing tool contract on the server entry", () => {
    const tool = defineTool({
      name: "acme.lookup",
      title: "Lookup",
      description: "Look up a record.",
      input: z.object({ query: z.string() }),
      output: z.object({ value: z.string() }),
      handler: (input) => ({ value: input.query }),
    });

    expect(tool.name).toBe("acme.lookup");
    expect(tool.input.parse({ query: "Paseo" })).toEqual({ query: "Paseo" });
  });
});
