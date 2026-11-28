/** An installed plugin's page. Its settings screens open at `buildPluginSettingsRoute`. */
export function buildPluginPageRoute(serverId: string, pluginId: string) {
  return {
    pathname: "/settings/hosts/[serverId]/plugins/[pluginId]" as const,
    params: { serverId, pluginId },
  };
}

/** A directory listing's page, by its `owner/slug` ID. */
export function buildPluginListingRoute(serverId: string, listingId: string) {
  const [owner = "", slug = ""] = listingId.split("/");
  return {
    pathname: "/settings/hosts/[serverId]/plugin-directory/[owner]/[slug]" as const,
    params: { serverId, owner, slug },
  };
}
