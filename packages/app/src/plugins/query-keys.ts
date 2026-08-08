/**
 * The installed-list key is a prefix of the entry key on purpose: one
 * `plugins.changed` invalidation then drops the entry HTML derived from it.
 */
export function pluginsQueryKey(serverId: string | null) {
  return ["plugins", serverId ?? ""] as const;
}

export function pluginEntryQueryKey(serverId: string | null, pluginId: string, entry: string) {
  return ["plugins", serverId ?? "", "entry", pluginId, entry] as const;
}

/**
 * Deliberately its own root key. The registry is a remote HTTP fetch the daemon
 * proxies; sitting under the `plugins` prefix made every enable/disable toggle
 * re-download it.
 */
export function pluginRegistryQueryKey(serverId: string | null) {
  return ["plugin-registry", serverId ?? ""] as const;
}
