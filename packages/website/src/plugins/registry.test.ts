import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  formatInstalls,
  installCommand,
  pinnedInstallCommand,
  queryPlugins,
  type Plugin,
} from "./registry";
import { loadRegistryIndex, loadRegistryPlugin } from "./published";
const plugin: Plugin = {
  id: "acme/example",
  name: "Example",
  description: "An example",
  categories: ["themes"],
  author: { github: "acme" },
  repository: { url: "https://github.com/acme/example" },
  artifact: {
    kind: "npm",
    package: "paseo-example",
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/example.tgz",
    integrity: "sha512-YWJj",
  },
  screenshots: [],
  submittedAt: "2026-10-03",
  reviewedAt: "2026-10-03",
  updatedAt: "2026-10-03",
  publishedAt: "2026-10-03",
  installs: 42,
};
describe("plugin registry", () => {
  it("loads a directory and a detail from a static HTTP registry", async () => {
    const index = {
      schemaVersion: 1,
      registry: { name: "Internal", url: "https://example.test" },
      categories: [],
      plugins: [plugin],
      generatedAt: "2026-10-03",
    };
    const detail = { ...plugin, readme: "# Example" };
    const server = createServer((request, response) => {
      const value = request.url === "/index.json" ? index : detail;
      response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const base = `http://127.0.0.1:${address.port}`;
    const context = { cache: null, waitUntil: () => undefined };
    try {
      expect(await loadRegistryIndex(base, context)).toEqual(index);
      expect(await loadRegistryPlugin(base, plugin.id, context)).toEqual(detail);
      await expect(loadRegistryPlugin(base, "acme/wrong", context)).rejects.toThrow("different ID");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("filters namespaced IDs and ranks by installs", () => {
    const popular = { ...plugin, id: "acme/popular", installs: 100 };
    expect(queryPlugins([plugin, popular], { sort: "popular" }).map((p) => p.id)).toEqual([
      "acme/popular",
      "acme/example",
    ]);
    expect(queryPlugins([plugin, popular], { q: "acme/example", sort: "new" })).toEqual([plugin]);
    expect(queryPlugins([plugin], { category: "utils", sort: "popular" })).toEqual([]);
  });
  it("offers a registry command and an exact explicit command", () => {
    expect(installCommand(plugin)).toBe("paseo plugin install acme/example");
    expect(pinnedInstallCommand(plugin)).toBe("paseo plugin install npm:paseo-example@1.2.3");
    expect(
      pinnedInstallCommand({
        ...plugin,
        artifact: {
          kind: "git",
          remote: "https://github.com/acme/plugins.git",
          commit: "a".repeat(40),
          pluginPath: "packages/example",
        },
      }),
    ).toBe(`paseo plugin install github:acme/plugins:packages/example --ref ${"a".repeat(40)}`);
    expect(formatInstalls(1250)).toBe("1.3k");
  });
});
