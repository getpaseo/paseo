import type { ConfigEntry, PluginInfo } from "@opencode/client";
import type { AgentModelDefinition } from "../../../agent-sdk-types.js";
import { projectMiniMaxCatalog } from "../minimax-catalog.js";

export function applyV2MiniMaxCatalog(
  models: AgentModelDefinition[],
  config: ConfigEntry[],
  plugins: PluginInfo[],
  isPaseoPlugin: (specifier: string) => boolean,
): AgentModelDefinition[] {
  // Native plugins can register a replacement with the same ID and endpoint.
  // Only runtime built-ins and the exact bridge owned by this instance are known.
  if (
    plugins.some(
      (plugin) =>
        plugin.source.type !== "builtin" &&
        !(plugin.source.type === "local" && isPaseoPlugin(plugin.source.path)),
    )
  )
    return models;

  const customProviders = new Set<string>();
  for (const entry of config) {
    if (entry.type !== "document") continue;
    // Also inspect config so a plugin that failed to register cannot be mistaken
    // for a complete, built-in inventory. Directory plugins are in plugin.list.
    if (
      entry.info.plugins?.some(
        (plugin) => !isPaseoPlugin(typeof plugin === "string" ? plugin : plugin.package),
      )
    )
      return models;
    for (const id of Object.keys(entry.info.providers ?? {})) customProviders.add(id);
  }
  return projectMiniMaxCatalog(models, (_model, providerId) =>
    customProviders.has(providerId) ? "custom" : "builtin",
  );
}
