const PLUGIN_CLIENT_ID_PREFIX = "plugin:";

export function createPluginClientId(pluginId: string): string {
  return `${PLUGIN_CLIENT_ID_PREFIX}${pluginId}`;
}

export function parsePluginClientId(clientId: string): string | null {
  return isPluginClientId(clientId) ? clientId.slice(PLUGIN_CLIENT_ID_PREFIX.length) : null;
}

export function isPluginClientId(clientId: string): boolean {
  return clientId.startsWith(PLUGIN_CLIENT_ID_PREFIX);
}
