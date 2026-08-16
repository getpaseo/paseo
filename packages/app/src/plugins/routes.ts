export function buildPluginSurfaceRoute(
  serverId: string,
  pluginId: string,
  contributionId: string,
): `/h/${string}/plugin/${string}/${string}` {
  return `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/${encodeURIComponent(contributionId)}`;
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
