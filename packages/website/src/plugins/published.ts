import {
  PluginRegistryIdSchema,
  PluginRegistryIndexSchema,
  PublishedPluginDetailSchema,
} from "@getpaseo/protocol/plugin-registry";
import { getBlockingColdCache, type WebsiteCacheContext } from "../github-cache";
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
  if (url.pathname === "/api/plugins/installs") {
    const index = await loadRegistryIndex(base, context);
    const entries = await Promise.all(
      index.plugins.map(
        async (plugin) =>
          [
            plugin.id,
            Number((await context.cache?.get(`plugin-installs:${plugin.id}`)) ?? 0),
          ] as const,
      ),
    );
    return Response.json(Object.fromEntries(entries));
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
    if (cache)
      context.waitUntil(
        (async () => {
          const key = `plugin-installs:${id}`;
          const count = Number((await cache.get(key)) ?? 0);
          await cache.put(key, String(count + 1));
        })().catch(() => undefined),
      );
  }
  return Response.json(plugin);
}
