/**
 * The three built-in tabs plus one per plugin sidebar panel. A plugin tab is
 * remembered like any other, so `isExplorerTab` accepts a plugin tab whose
 * plugin may no longer be installed — the sidebar falls back when it renders.
 */
export type ExplorerTab = "changes" | "files" | "pr" | `plugin:${string}`;

const PLUGIN_TAB_PREFIX = "plugin:";

export function buildPluginExplorerTab(pluginId: string, panelId: string): ExplorerTab {
  return `${PLUGIN_TAB_PREFIX}${pluginId}:${panelId}`;
}

export function isPluginExplorerTab(tab: ExplorerTab): boolean {
  return tab.startsWith(PLUGIN_TAB_PREFIX);
}

export function isExplorerTab(value: unknown): value is ExplorerTab {
  if (value === "changes" || value === "files" || value === "pr") {
    return true;
  }
  return (
    typeof value === "string" &&
    value.length > PLUGIN_TAB_PREFIX.length &&
    value.startsWith(PLUGIN_TAB_PREFIX)
  );
}

export function buildExplorerCheckoutKey(serverId: string, cwd: string): string | null {
  const trimmedServerId = serverId.trim();
  const trimmedCwd = cwd.trim();
  if (!trimmedServerId || !trimmedCwd) {
    return null;
  }
  return `${trimmedServerId}::${trimmedCwd}`;
}

export function coerceExplorerTabForCheckout(tab: ExplorerTab, isGit: boolean): ExplorerTab {
  if (!isGit && tab === "changes") {
    return "files";
  }
  return tab;
}

export function resolveExplorerTabForCheckout(params: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}): ExplorerTab {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  const stored = key ? params.explorerTabByCheckout[key] : null;
  const defaultTab: ExplorerTab = params.isGit ? "changes" : "files";
  const nextTab = stored && isExplorerTab(stored) ? stored : defaultTab;
  return coerceExplorerTabForCheckout(nextTab, params.isGit);
}
