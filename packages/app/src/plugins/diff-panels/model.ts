import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { InstalledPlugin, PluginDiffPanelContribution } from "../types";

export interface InstalledDiffPanel {
  plugin: InstalledPlugin;
  contribution: PluginDiffPanelContribution;
}

/** Catalog order decides ownership; the chosen plugin controls its own opt-in. */
export function resolvePluginDiffPanel(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): InstalledDiffPanel | null {
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    const contribution = plugin.diffPanels?.[0];
    if (contribution) return { plugin, contribution };
  }
  return null;
}

function stateRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function readPluginDiffPanelState(state: JsonValue | undefined, key: string): unknown {
  return stateRecord(stateRecord(state).pluginDiffPanels)[key];
}

export function withPluginDiffPanelState(
  state: JsonValue | undefined,
  key: string,
  next: JsonValue,
): JsonValue {
  const current = stateRecord(state);
  return {
    ...current,
    pluginDiffPanels: { ...stateRecord(current.pluginDiffPanels), [key]: next },
  };
}
