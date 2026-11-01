import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { getTranslator } from "~/i18n";
import {
  addedAgo,
  featuredPlugins,
  formatInstalls,
  installCommand,
  mostInstalled,
  newestFirst,
  type Plugin,
  pluginListing,
  pluginOverview,
  readmeBody,
  recentlyUpdated,
  reportBugUrl,
  searchPlugins,
  updatedAgo,
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
  media: [],
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
      featured: [plugin.id],
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
  it("features listed plugins once each, in the registry's order, dropping IDs that are not listed", () => {
    const listed = [
      { ...plugin, id: "acme/first" },
      { ...plugin, id: "acme/second" },
      { ...plugin, id: "acme/third" },
    ];
    const featured = ["acme/third", "acme/not-published", "acme/first", "acme/third"];
    expect(featuredPlugins(listed, featured).map((p) => p.id)).toEqual([
      "acme/third",
      "acme/first",
    ]);
    expect(featuredPlugins(listed, ["acme/not-published"])).toEqual([]);
  });
  it("lists what's new by first listing time, so neither a slow review nor an update moves a plugin", () => {
    const listedFirst = {
      ...plugin,
      id: "acme/listed-first",
      submittedAt: "2026-09-30T00:00:00.000Z",
      publishedAt: "2026-09-30T06:00:00.000Z",
      reviewedAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    const listedLater = {
      ...plugin,
      id: "acme/listed-later",
      submittedAt: "2026-09-02T00:00:00.000Z",
      publishedAt: "2026-09-30T08:00:00.000Z",
      reviewedAt: "2026-09-30T08:00:00.000Z",
      updatedAt: "2026-09-30T08:00:00.000Z",
    };
    expect(newestFirst([listedFirst, listedLater]).map((p) => p.id)).toEqual([
      "acme/listed-later",
      "acme/listed-first",
    ]);
    const now = "2026-10-03T12:00:00.000Z";
    expect(addedAgo(listedLater, now, getTranslator("en"))).toBe("3d ago");
    expect(updatedAgo(listedFirst, now, getTranslator("en"))).toBe("yesterday");
    expect(addedAgo(listedLater, now, getTranslator("zh-CN"))).toBe("3 天前");
    expect(updatedAgo(listedFirst, now, getTranslator("zh-CN"))).toBe("昨天");
  });
  it("lists only plugins updated after their first listing as recently updated, latest update first", () => {
    const bumped = {
      ...plugin,
      id: "acme/bumped",
      publishedAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    };
    const bumpedLater = {
      ...plugin,
      id: "acme/bumped-later",
      publishedAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-10-01T17:00:00.000Z",
    };
    const neverUpdated = {
      ...plugin,
      id: "acme/never-updated",
      publishedAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    expect(recentlyUpdated([bumped, neverUpdated, bumpedLater]).map((p) => p.id)).toEqual([
      "acme/bumped-later",
      "acme/bumped",
    ]);
  });
  it("orders by first listing time and by installs in a window, keeping index order for ties", () => {
    const older = { ...plugin, id: "acme/older", publishedAt: "2026-09-01" };
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
          featured: [],
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
    expect(searchPlugins(plugins, "EXAMPLE", "en").map((p) => p.id)).toEqual(["acme/example"]);
    expect(searchPlugins(plugins, "unrelated", "en").map((p) => p.id)).toEqual(["zed/other"]);
    expect(searchPlugins(plugins, "zed/", "en").map((p) => p.id)).toEqual(["zed/other"]);
    expect(searchPlugins(plugins, "acme", "en").map((p) => p.id)).toEqual(["acme/example"]);
    expect(searchPlugins(plugins, "  ", "en")).toEqual(plugins);
    expect(searchPlugins(plugins, "nothing", "en")).toEqual([]);
  });
  it("ranks name, then author, then description matches, keeping the given order on ties", () => {
    const named = (id: string, name: string, description: string, github = "acme"): Plugin => ({
      ...plugin,
      id,
      name,
      description,
      author: { github },
    });
    // Given in install order: description-only matches first, the exact name last.
    const plugins = [
      named("acme/editor", "Remote Editor", "Composer pill to open a workspace"),
      named("acme/kit", "PromptKit", "Rewrite prompts"),
      named("omp/tools", "Tools", "Helpers", "omp"),
      named("acme/history", "History", "Inspect raw composer records"),
      named("acme/omp", "OMP", "Paseo integration for OMP"),
    ];
    expect(searchPlugins(plugins, "omp", "en").map((p) => p.id)).toEqual([
      "acme/omp",
      "acme/kit",
      "omp/tools",
      "acme/editor",
      "acme/history",
    ]);
    expect(searchPlugins(plugins, "prompt", "en").map((p) => p.id)).toEqual(["acme/kit"]);
    expect(searchPlugins(plugins, "tools omp", "en").map((p) => p.id)).toEqual(["omp/tools"]);
  });

  it("shows each listing field in the reader's language, falling back to English per field", () => {
    const translated: Plugin = {
      ...plugin,
      translations: { "zh-CN": { description: "一个示例" } },
    };
    expect(pluginListing(translated, "zh-CN")).toEqual({
      name: "Example",
      description: "一个示例",
    });
    expect(pluginListing(translated, "en")).toEqual({ name: "Example", description: "An example" });
    expect(pluginListing(plugin, "zh-CN")).toEqual({ name: "Example", description: "An example" });
  });

  it("shows a translated overview whole, or the whole English README when there is none", () => {
    const detail = { ...plugin, readme: "# Example\n\nEnglish body\n" };
    expect(pluginOverview(detail, "zh-CN")).toEqual({ raw: detail.readme, locale: "en" });
    const translated = { ...detail, overviewTranslations: { "zh-CN": "# 示例\n\n中文正文\n" } };
    expect(pluginOverview(translated, "zh-CN")).toEqual({
      raw: "# 示例\n\n中文正文\n",
      locale: "zh-CN",
    });
    expect(pluginOverview(translated, "en")).toEqual({ raw: detail.readme, locale: "en" });
  });

  it("searches the reader's language and English, but not other languages", () => {
    const theme: Plugin = {
      ...plugin,
      id: "acme/midnight",
      name: "Midnight",
      description: "A dark theme",
      translations: { "zh-CN": { name: "午夜", description: "深色主题" } },
    };
    const plugins = [plugin, theme];
    expect(searchPlugins(plugins, "午夜", "zh-CN").map((p) => p.id)).toEqual(["acme/midnight"]);
    expect(searchPlugins(plugins, "深色", "zh-CN").map((p) => p.id)).toEqual(["acme/midnight"]);
    expect(searchPlugins(plugins, "midnight", "zh-CN").map((p) => p.id)).toEqual(["acme/midnight"]);
    expect(searchPlugins(plugins, "dark", "zh-CN").map((p) => p.id)).toEqual(["acme/midnight"]);
    expect(searchPlugins(plugins, "午夜", "en")).toEqual([]);
  });

  it("lists every plugin page in each language with reciprocal alternates", async () => {
    const response = await handlePluginRegistryRequest(
      new Request("https://paseo.sh/sitemap-plugins.xml"),
      { PLUGINS_REGISTRY_URL: "https://registry.example.test" },
      { cache: seededIndex(), waitUntil: () => undefined },
    );
    const xml = (await response?.text()) ?? "";
    const english = "https://paseo.sh/plugins/acme/example";
    const chinese = "https://paseo.sh/zh-CN/plugins/acme/example";
    for (const loc of [english, chinese]) {
      expect(xml).toContain(
        `<url><loc>${loc}</loc>` +
          `<xhtml:link rel="alternate" hreflang="en" href="${english}"/>` +
          `<xhtml:link rel="alternate" hreflang="zh-CN" href="${chinese}"/>` +
          `<xhtml:link rel="alternate" hreflang="x-default" href="${english}"/></url>`,
      );
    }
    expect(xml).toContain("<loc>https://paseo.sh/zh-CN/plugins/category/themes</loc>");
  });

  it("strips the README title and quoted description that the page already shows", () => {
    expect(readmeBody("# Example\n\n> An example\n> plugin\n\n## Usage\n")).toBe("## Usage\n");
    expect(readmeBody("## Usage\n\n> Note\n")).toBe("## Usage\n\n> Note\n");
    expect(readmeBody("# Example\n\n> [!WARNING]\n> Needs Docker\n\n## Usage\n")).toBe(
      "> [!WARNING]\n> Needs Docker\n\n## Usage\n",
    );
  });
  it("offers a registry install command", () => {
    expect(installCommand(plugin)).toBe("paseo plugin add acme/example");
    expect(formatInstalls(1250)).toBe("1.3k");
  });
  it("reports bugs on the source repository's GitHub issue tracker", () => {
    const at = (url: string) => reportBugUrl({ ...plugin, repository: { url } });
    expect(at("https://github.com/acme/example")).toBe(
      "https://github.com/acme/example/issues/new",
    );
    expect(at("https://github.com/acme/plugins.git")).toBe(
      "https://github.com/acme/plugins/issues/new",
    );
    expect(at("https://github.com/acme/plugins/tree/HEAD/packages/example")).toBe(
      "https://github.com/acme/plugins/issues/new",
    );
    expect(at("https://gitlab.com/acme/example")).toBeUndefined();
    expect(at("javascript:alert(1)")).toBeUndefined();
  });
});

/** A cache holding a fresh registry index with `plugin`, so no request reaches the registry. */
function seededIndex(): KVNamespace {
  const cache = memoryKv();
  const index = {
    schemaVersion: 1,
    registry: { name: "Test", url: "https://registry.example.test" },
    categories: [],
    plugins: [plugin],
    featured: [],
    generatedAt: "2026-10-03",
  };
  void cache.put(
    "plugins:index:v1:https://registry.example.test",
    JSON.stringify({ fetchedAt: Date.now(), value: index }),
  );
  return cache;
}

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
