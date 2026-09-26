import { readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createPluginImportReader } from "./compiler-imports.js";
import { compilePlugin } from "./compiler.js";

const root = fileURLToPath(new URL("../../plugins/", import.meta.url));

test("internal plugins keep every import inside the public plugin boundary", async () => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const server = path.join(directory, "index.server.ts");
    await compilePlugin({ server, client: null });
    const reader = createPluginImportReader(directory);
    const pending = [server];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const dependency of reader.read(file)) {
        const specifier = dependency.specifier;
        if (specifier === "@getpaseo/plugin" || specifier.startsWith("@getpaseo/plugin/")) continue;
        if (isBuiltin(specifier)) continue;
        const resolved = reader.resolve(specifier, file, dependency.kind);
        expect(resolved, `${file}: ${specifier}`).toBeDefined();
        const relative = path.relative(directory, resolved!);
        expect(relative, `${file}: ${specifier}`).toMatch(/^(server|shared)\//);
        pending.push(resolved!);
      }
    }
  }
});
