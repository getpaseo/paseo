/**
 * Which explorer tab actually renders, and which plugin panel fills it.
 *
 * Pure, and out of `explorer-sidebar.tsx` so it can be tested: the remembered
 * tab, the PR tab's availability and the plugin list all disagree with each
 * other during startup, and every combination used to be exercised only by
 * running the whole sidebar.
 */
import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";
import {
  buildPluginExplorerTab,
  isPluginExplorerTab,
  type ExplorerTab,
} from "@/stores/explorer-tab-memory";

export interface PluginSidebarTab {
  tab: ExplorerTab;
  pluginId: string;
  pluginName: string;
  title: string;
  entry: string;
}

/**
 * Enabled, usable plugins' sidebar panels, ordered stably by plugin id.
 *
 * First panel wins a repeated id. The tab key is `plugin:<id>:<panel>`, so a
 * manifest declaring the same panel id twice produces two identical keys — a
 * duplicate React key, and a second tab that can never be selected because the
 * first answers to the same key. Nothing rejects such a manifest: the id is
 * unique per plugin only by convention.
 */
export function resolvePluginSidebarTabs(
  plugins: readonly InstalledPlugin[],
): readonly PluginSidebarTab[] {
  return [...plugins]
    .filter((plugin) => plugin.enabled && plugin.unavailableReason === null)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .flatMap((plugin) => {
      const seen = new Set<string>();
      return (plugin.manifest.contributes.sidebarPanels ?? [])
        .filter((panel) => {
          if (seen.has(panel.id)) {
            return false;
          }
          seen.add(panel.id);
          return true;
        })
        .map((panel) => ({
          tab: buildPluginExplorerTab(plugin.manifest.id, panel.id),
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          title: panel.title,
          entry: panel.entry,
        }));
    });
}

export interface ExplorerTabResolution {
  resolvedTab: ExplorerTab;
  activePluginTab: PluginSidebarTab | null;
  /** The requested plugin tab is held open waiting for the list. */
  pluginTabPending: boolean;
}

export function resolveExplorerTab(input: {
  activeTab: ExplorerTab;
  isGit: boolean;
  showPrTab: boolean;
  pluginTabs: readonly PluginSidebarTab[];
  pluginsLoading: boolean;
}): ExplorerTabResolution {
  const requestedTab: ExplorerTab =
    !input.isGit && (input.activeTab === "changes" || input.activeTab === "pr")
      ? "files"
      : input.activeTab;
  const fallback: ExplorerTab = input.isGit ? "changes" : "files";
  // A remembered plugin tab outlives its plugin: fall back rather than render
  // a tab nothing can fill.
  const activePluginTab = input.pluginTabs.find((panel) => panel.tab === requestedTab) ?? null;
  if (requestedTab === "pr" && !input.showPrTab) {
    return { resolvedTab: "changes", activePluginTab: null, pluginTabPending: false };
  }
  if (isPluginExplorerTab(requestedTab) && !activePluginTab) {
    // Before the plugin list lands, every plugin tab looks uninstalled. Falling
    // back here would mount Changes and fire its git RPCs for the split second
    // until the list arrives, then swap. Hold the requested tab instead, and say
    // so, because no tab button is highlighted while the list is missing and a
    // silent blank pane is indistinguishable from a broken one.
    //
    // The caller bounds `pluginsLoading`; it stays true for as long as the host
    // has not finished its handshake, which for an unreachable host is forever.
    if (input.pluginsLoading) {
      return { resolvedTab: requestedTab, activePluginTab: null, pluginTabPending: true };
    }
    return { resolvedTab: fallback, activePluginTab: null, pluginTabPending: false };
  }
  return { resolvedTab: requestedTab, activePluginTab, pluginTabPending: false };
}
