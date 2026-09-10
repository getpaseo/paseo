import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("plugin runtime-entry migration guide", () => {
  it("maps every client registration method", async () => {
    const contracts = await readFile(new URL("./client/contracts.ts", import.meta.url), "utf8");
    const context = /export interface PluginClientContext[^{]*{([\s\S]*?)\n}/.exec(contracts)?.[1];
    if (!context) throw new Error("PluginClientContext was not found");
    const methods = [...context.matchAll(/^\s+(add[A-Z]\w*)\(/gm)].map((match) => match[1]);
    const migration = await readFile(
      fileURLToPath(new URL("../../../public-docs/plugins/v0.8/migration.md", import.meta.url)),
      "utf8",
    );
    const table = migration.slice(
      migration.indexOf("| Old registration and location"),
      migration.indexOf("## 4. Separate imports"),
    );

    expect(methods).not.toEqual([]);
    for (const method of methods) expect(table).toContain(`client.${method}(`);
  });
});
