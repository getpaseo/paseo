import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  formatInstalls,
  installCommand,
  mostInstalled,
  newestFirst,
  type Plugin,
  readmeBody,
  searchPlugins,
} from "./registry";
import { readInstallCounts, recordInstall } from "./installs";
import { handlePluginRegistryRequest, loadRegistryIndex, loadRegistryPlugin } from "./published";
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
  it("orders by submission date and by installs in a window, keeping index order for ties", () => {
    const older = { ...plugin, id: "acme/older", submittedAt: "2026-09-01" };
    const twin = { ...plugin, id: "acme/twin" };
    expect(newestFirst([older, plugin, twin]).map((p) => p.id)).toEqual([
      "acme/example",
      "acme/twin",
      "acme/older",
    ]);
    const installs = {
      "acme/example": { week: 1, month: 5, all: 9 },
      "acme/older": { week: 3, month: 3, all: 3 },
      "acme/twin": { week: 1, month: 1, all: 1 },
    };
    expect(mostInstalled([plugin, older, twin], installs, "week").map((p) => p.id)).toEqual([
      "acme/older",
      "acme/example",
      "acme/twin",
    ]);
    expect(mostInstalled([plugin, older, twin], installs, "month")[0].id).toBe("acme/example");
  });
  it("counts installs this week, this month, and all time from the daily record", async () => {
    const cache = memoryKv();
    const day = (date: string) => new Date(`${date}T12:00:00.000Z`);
    await cache.put("plugin-installs:acme/example", "40");
    await recordInstall(cache, "acme/example", day("2026-07-01"));
    await recordInstall(cache, "acme/example", day("2026-09-10"));
    await recordInstall(cache, "acme/example", day("2026-09-30"));
    await recordInstall(cache, "acme/example", day("2026-10-04"));
    expect(await readInstallCounts(cache, ["acme/example"], day("2026-10-04"))).toEqual({
      "acme/example": { week: 2, month: 3, all: 44 },
    });
    expect(
      Object.keys(JSON.parse((await cache.get("plugin-installs-daily:acme/example")) ?? "{}")),
    ).toEqual(["2026-09-10", "2026-09-30", "2026-10-04"]);
  });
  it("counts repeated install reports from the same IP once per hour", async () => {
    let now = Date.now();
    const cache = memoryKv(() => now);
    const headers = { "X-Paseo-Install": "1", "CF-Connecting-IP": "192.0.2.1" };
    await resolvePlugin(cache, headers);
    now += 3_599_000;
    await resolvePlugin(cache, headers);
    expect(await readInstallCounts(cache, [plugin.id], new Date())).toEqual({
      [plugin.id]: { week: 1, month: 1, all: 1 },
    });
    now += 1_000;
    await resolvePlugin(cache, headers);
    expect(await readInstallCounts(cache, [plugin.id], new Date())).toEqual({
      [plugin.id]: { week: 2, month: 2, all: 2 },
    });
  });
  it("counts different IPs and plugins independently, including query install intent", async () => {
    const cache = memoryKv();
    const first = { "X-Paseo-Install": "1", "CF-Connecting-IP": "192.0.2.1" };
    await resolvePlugin(cache, first);
    await resolvePlugin(cache, { "CF-Connecting-IP": "2001:db8::1" }, { query: "?intent=install" });
    await resolvePlugin(cache, first, { id: "acme/other" });
    await resolvePlugin(cache, first, { query: "?intent=install" });
    await resolvePlugin(cache, first, { id: "acme/other", staticDetail: true });
    expect(await readInstallCounts(cache, [plugin.id, "acme/other"], new Date())).toEqual({
      [plugin.id]: { week: 2, month: 2, all: 2 },
      "acme/other": { week: 1, month: 1, all: 1 },
    });
    const hash = createHash("sha256").update(first["CF-Connecting-IP"]).digest("hex");
    expect(await cache.get(`plugin-installs-client:${plugin.id}:${hash}`)).toBe("1");
    expect(JSON.stringify([...cache.values])).not.toContain("192.0.2.1");
    expect(JSON.stringify([...cache.values])).not.toContain("2001:db8::1");
  });
  it("does not count without a Cloudflare IP or install intent", async () => {
    const cache = memoryKv();
    await resolvePlugin(cache, { "X-Paseo-Install": "1", "X-Forwarded-For": "192.0.2.1" });
    await resolvePlugin(cache, {}, { query: "?intent=install" });
    await resolvePlugin(cache, { "X-Paseo-Install": "1", "CF-Connecting-IP": "" });
    await resolvePlugin(cache, { "CF-Connecting-IP": "192.0.2.1" });
    expect(await readInstallCounts(cache, [plugin.id], new Date())).toEqual({
      [plugin.id]: { week: 0, month: 0, all: 0 },
    });
    expect([...cache.values.keys()].filter((key) => key.startsWith("plugin-installs"))).toEqual([]);
  });
  it("preserves historical totals and the installs endpoint response", async () => {
    const cache = memoryKv();
    await cache.put(`plugin-installs:${plugin.id}`, "40");
    const headers = { "X-Paseo-Install": "1", "CF-Connecting-IP": "192.0.2.1" };
    await resolvePlugin(cache, headers);
    await resolvePlugin(cache, headers);
    const base = "https://registry.example.test";
    await cache.put(
      `plugins:index:v1:${base}`,
      JSON.stringify({
        fetchedAt: Date.now(),
        value: {
          schemaVersion: 1,
          registry: { name: "Internal", url: base },
          categories: [],
          plugins: [plugin],
          generatedAt: "2026-10-03",
        },
      }),
    );
    const response = await handlePluginRegistryRequest(
      new Request("https://paseo.sh/api/plugins/installs"),
      { PLUGINS_REGISTRY_URL: base },
      { cache, waitUntil: () => undefined },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ [plugin.id]: 41 });
    expect(await readInstallCounts(cache, [plugin.id], new Date())).toEqual({
      [plugin.id]: { week: 1, month: 1, all: 41 },
    });
  });
  it("searches name, description, ID, and author, ignoring case", () => {
    const other = {
      ...plugin,
      id: "zed/other",
      name: "Other",
      description: "Unrelated",
      author: { github: "zed" },
    };
    const plugins = [plugin, other];
    expect(searchPlugins(plugins, "EXAMPLE").map((p) => p.id)).toEqual(["acme/example"]);
    expect(searchPlugins(plugins, "unrelated").map((p) => p.id)).toEqual(["zed/other"]);
    expect(searchPlugins(plugins, "zed/").map((p) => p.id)).toEqual(["zed/other"]);
    expect(searchPlugins(plugins, "acme").map((p) => p.id)).toEqual(["acme/example"]);
    expect(searchPlugins(plugins, "  ")).toEqual(plugins);
    expect(searchPlugins(plugins, "nothing")).toEqual([]);
  });

  it("strips the README title and quoted description that the page already shows", () => {
    expect(readmeBody("# Example\n\n> An example\n> plugin\n\n## Usage\n")).toBe("## Usage\n");
    expect(readmeBody("## Usage\n\n> Note\n")).toBe("## Usage\n\n> Note\n");
    expect(readmeBody("# Example\n\n> [!WARNING]\n> Needs Docker\n\n## Usage\n")).toBe(
      "> [!WARNING]\n> Needs Docker\n\n## Usage\n",
    );
  });
  it("offers a registry install command", () => {
    expect(installCommand(plugin)).toBe("paseo plugin install acme/example");
    expect(formatInstalls(1250)).toBe("1.3k");
  });
});

/** In-memory stand-in for the website KV namespace, covering the calls the counter makes. */
function memoryKv(now = Date.now): KVNamespace & { values: Map<string, string> } {
  const values = new Map<string, string>();
  const expiresAt = new Map<string, number>();
  const kv = {
    values,
    get: async (key: string, options?: { type?: string }) => {
      if (now() >= (expiresAt.get(key) ?? Infinity)) values.delete(key);
      const value = values.get(key) ?? null;
      return options?.type === "json" && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      values.set(key, value);
      expiresAt.set(key, options?.expirationTtl ? now() + options.expirationTtl * 1000 : Infinity);
    },
  };
  return kv as unknown as KVNamespace & { values: Map<string, string> };
}

async function resolvePlugin(
  cache: KVNamespace,
  headers: HeadersInit,
  { id = plugin.id, query = "", staticDetail = false } = {},
): Promise<void> {
  const base = "https://registry.example.test";
  const detail = { ...plugin, id, readme: "# Example" };
  await cache.put(
    `plugins:detail:v1:${base}:${id}`,
    JSON.stringify({ fetchedAt: Date.now(), value: detail }),
  );
  const pending: Promise<unknown>[] = [];
  const path = staticDetail ? `/plugins/${id}.json` : `/api/plugins/resolve/${id}`;
  const response = await handlePluginRegistryRequest(
    new Request(`https://paseo.sh${path}${query}`, { headers }),
    { PLUGINS_REGISTRY_URL: base },
    { cache, waitUntil: (promise) => pending.push(promise) },
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(detail);
  await Promise.all(pending);
}
