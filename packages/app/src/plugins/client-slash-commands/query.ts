export function pluginSlashCommandProviderQueryKey(serverId: string, pluginId: string) {
  return ["plugin-slash-command-provider", serverId, pluginId] as const;
}
