import type { PluginScreenParams } from "@getpaseo/plugin/client";
import type { PluginSurfaceContributionIdentity } from "./surface-contribution";

type PluginSurfaceRoute<Kind extends PluginSurfaceContributionIdentity["kind"]> =
  `/h/${string}/plugin/${string}/${Kind}/${string}`;

/**
 * Expo Router merges the route's segments (`serverId`, `pluginId`, ...) into the same search params
 * as the query. Prefixing screen param keys keeps any plugin key clear of them.
 */
const SCREEN_PARAM_PREFIX = "param.";

/** Screen params ride in the route's query, so reload, history and deep links keep them. */
export function buildPluginSurfaceRoute<Identity extends PluginSurfaceContributionIdentity>(
  serverId: string,
  pluginId: string,
  identity: Identity,
  params: PluginScreenParams = {},
): PluginSurfaceRoute<Identity["kind"]> {
  const path = `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/${identity.kind}/${encodeURIComponent(identity.id)}`;
  const query = Object.entries(params)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(SCREEN_PARAM_PREFIX + key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  return (query ? `${path}?${query}` : path) as PluginSurfaceRoute<Identity["kind"]>;
}

/** Checks params a plugin passed to `openScreen`: an object of string values. Throws otherwise. */
export function parsePluginScreenParams(value: unknown): PluginScreenParams {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin screen params must be an object of strings");
  }
  const params: PluginScreenParams = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Plugin screen param ${key} must be a string`);
    }
    params[key] = entry;
  }
  return params;
}

/** The screen params in a plugin screen route's search params (`useLocalSearchParams`). */
export function pluginScreenParamsFromRoute(
  routeParams: Readonly<Record<string, string | string[] | undefined>>,
): PluginScreenParams {
  const params: PluginScreenParams = {};
  for (const [key, value] of Object.entries(routeParams)) {
    if (!key.startsWith(SCREEN_PARAM_PREFIX) || typeof value !== "string") continue;
    params[key.slice(SCREEN_PARAM_PREFIX.length)] = value;
  }
  return params;
}

export function buildLegacyPluginSurfaceRedirectRoute(
  serverId: string,
  pluginId: string,
  sidebarContributionId: string,
): `/h/${string}/plugin/${string}/sidebar/${string}` {
  return buildPluginSurfaceRoute(serverId, pluginId, {
    kind: "sidebar",
    id: sidebarContributionId,
  });
}

export function hostIdFromPathname(pathname: string): string | null {
  const encoded = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function parsePluginSurfaceRoute(pathname: string): {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
} | null {
  const match = /^\/h\/([^/]+)\/plugin\/([^/]+)\/(sidebar|surface)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      serverId: decodeURIComponent(match[1]),
      pluginId: decodeURIComponent(match[2]),
      identity: { kind: match[3] as "sidebar" | "surface", id: decodeURIComponent(match[4]) },
    };
  } catch {
    return null;
  }
}
