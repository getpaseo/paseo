/**
 * The installed-list key is a prefix of the entry and registry keys on purpose:
 * one `plugins.changed` invalidation then drops everything derived from it.
 */
export function pluginsQueryKey(serverId: string | null) {
  return ["plugins", serverId ?? ""] as const;
}

export function pluginEntryQueryKey(serverId: string | null, pluginId: string, entry: string) {
  return ["plugins", serverId ?? "", "entry", pluginId, entry] as const;
}

export function pluginRegistryQueryKey(serverId: string | null) {
  return ["plugins", serverId ?? "", "registry"] as const;
}
