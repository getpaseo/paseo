import type { PluginSurfaceContributionIdentity } from "./surface-contribution";

type PluginSurfaceRoute<Kind extends PluginSurfaceContributionIdentity["kind"]> =
  `/h/${string}/plugin/${string}/${Kind}/${string}`;

export function buildPluginSurfaceRoute<Identity extends PluginSurfaceContributionIdentity>(
  serverId: string,
  pluginId: string,
  identity: Identity,
): PluginSurfaceRoute<Identity["kind"]> {
  return `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/${identity.kind}/${encodeURIComponent(identity.id)}` as PluginSurfaceRoute<
    Identity["kind"]
  >;
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
