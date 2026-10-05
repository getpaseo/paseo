import {
  PluginRegistryIdSchema,
  PluginRegistryIndexSchema,
  PublishedPluginDetailSchema,
} from "@getpaseo/protocol/plugin-registry";
import { getBlockingColdCache, type WebsiteCacheContext } from "../github-cache";
import { CATEGORIES } from "./categories";
import { type InstallCounts, readInstallCounts, recordInstall } from "./installs";
export interface RegistryEnvironment {
  PLUGINS_REGISTRY_URL?: string;
  WEBSITE_CACHE?: KVNamespace;
}
async function documentAt(base: string, path: string): Promise<unknown> {
  const response = await fetch(`${base.replace(/\/+$/, "")}/${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Plugin registry returned ${response.status}`);
  return response.json();
}
export function loadRegistryIndex(base: string, context: WebsiteCacheContext) {
  return getBlockingColdCache({
    context,
    key: `plugins:index:v1:${base}`,
    isValue: (value): value is ReturnType<typeof PluginRegistryIndexSchema.parse> =>
      PluginRegistryIndexSchema.safeParse(value).success,
    fetchFresh: async () => PluginRegistryIndexSchema.parse(await documentAt(base, "index.json")),
  });
}
/** Install counts per window for every listed plugin, refreshed with the index cache. */
export async function loadInstallCounts(base: string, context: WebsiteCacheContext) {
  const index = await loadRegistryIndex(base, context);
  const ids = index.plugins.map((plugin) => plugin.id);
  return getBlockingColdCache({
    context,
    key: `plugins:installs:v1:${base}`,
    isValue: (value): value is Record<string, InstallCounts> =>
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((counts) => typeof counts?.all === "number"),
    fetchFresh: () => readInstallCounts(context.cache, ids, new Date()),
  });
}
export async function loadRegistryPlugin(base: string, id: string, context: WebsiteCacheContext) {
  if (!PluginRegistryIdSchema.safeParse(id).success) return null;
  return getBlockingColdCache({
    context,
    key: `plugins:detail:v1:${base}:${id}`,
    isValue: (value): value is ReturnType<typeof PublishedPluginDetailSchema.parse> | null =>
      value === null || PublishedPluginDetailSchema.safeParse(value).success,
    fetchFresh: async () => {
      const raw = await documentAt(base, `plugins/${id}.json`);
      if (raw === null) return null;
      const plugin = PublishedPluginDetailSchema.parse(raw);
      if (plugin.id !== id) throw new Error("Plugin registry returned a different ID");
      return plugin;
    },
  });
}
export async function handlePluginRegistryRequest(
  request: Request,
  env: RegistryEnvironment,
  context: WebsiteCacheContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  const base = env.PLUGINS_REGISTRY_URL ?? "https://getpaseo.github.io/plugins";
  if (url.hostname === "plugins.paseo.sh" && url.pathname === "/index.json")
    return Response.json(await loadRegistryIndex(base, context));
  if (url.pathname === "/sitemap-plugins.xml") {
    const index = await loadRegistryIndex(base, context);
    // IDs are validated owner/slug strings, so these paths contain no XML metacharacters.
    const paths = new Set<string>(["/plugins", "/plugins/all"]);
    for (const category of CATEGORIES) {
      if (index.plugins.some((plugin) => plugin.categories.includes(category.slug)))
        paths.add(`/plugins/category/${category.slug}`);
    }
    for (const plugin of index.plugins) {
      paths.add(`/plugins/${plugin.id.split("/")[0]}`);
      paths.add(`/plugins/${plugin.id}`);
    }
    const urls = [...paths].sort().map((path) => `<url><loc>https://paseo.sh${path}</loc></url>`);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
      {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      },
    );
  }
  if (url.pathname === "/api/plugins/installs") {
    const index = await loadRegistryIndex(base, context);
    const counts = await readInstallCounts(
      context.cache,
      index.plugins.map((plugin) => plugin.id),
      new Date(),
    );
    return Response.json(
      Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, count.all])),
    );
  }
  const match =
    /^\/api\/plugins\/resolve\/([^/]+\/[^/]+)$/.exec(url.pathname) ??
    /^\/plugins\/([^/]+\/[^/]+)\.json$/.exec(url.pathname);
  if (!match) return null;
  const id = match[1];
  const plugin = await loadRegistryPlugin(base, id, context);
  if (!plugin) return Response.json({ error: "Plugin not found" }, { status: 404 });
  if (
    request.headers.get("X-Paseo-Install") === "1" ||
    url.searchParams.get("intent") === "install"
  ) {
    const cache = context.cache;
    if (cache) context.waitUntil(recordInstall(cache, id, new Date()).catch(() => undefined));
  }
  return Response.json(plugin);
}
