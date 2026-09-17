import type {
  PluginPanelLocation,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";
import type { PaneHost } from "@/panels/panel-manifest";
import { panelSupportsHost } from "@/panels/panel-manifest";
import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { pluginRegistry } from "../registry";
import { resolvePluginWorkspacePanel } from "./resolution";

const DEFAULT_LOCATIONS: readonly PluginPanelLocation[] = ["workspace"];

export function getPluginPanelLocations(
  panel: PluginWorkspacePanelContribution,
): readonly PluginPanelLocation[] {
  return panel.locations ?? DEFAULT_LOCATIONS;
}

export function pluginPanelSupportsLocation(
  panel: PluginWorkspacePanelContribution,
  location: PluginPanelLocation,
): boolean {
  return getPluginPanelLocations(panel).includes(location);
}

export function resolvePluginPanelOpenLocation(
  panel: PluginWorkspacePanelContribution,
  requested?: PluginPanelLocation,
): PluginPanelLocation {
  const locations = getPluginPanelLocations(panel);
  const location = requested ?? (locations.includes("workspace") ? "workspace" : locations[0]);
  if (!location || !locations.includes(location)) {
    throw new Error(`Workspace panel ${panel.id} does not support ${requested ?? "any"} location`);
  }
  return location;
}

function findPluginPanel(serverId: string, target: PluginWorkspaceTabTarget) {
  const plugin =
    pluginRegistry
      .getSnapshot()
      .find((candidate) => candidate.serverId === serverId && candidate.id === target.pluginId) ??
    null;
  return resolvePluginWorkspacePanel(plugin, target);
}

/** The single target-aware boundary for placement, drag, drop, and restoration. */
export function panelTargetSupportsHost(
  serverId: string,
  target: WorkspaceTabTarget,
  host: PaneHost,
): boolean {
  if (target.kind !== "plugin") return panelSupportsHost(target.kind, host);
  const panel = findPluginPanel(serverId, target);
  // Preserve a persisted unavailable panel where the user left it until its plugin loads again.
  if (!panel) return true;
  const location: PluginPanelLocation = host === "explorer" ? "explorer" : "workspace";
  return pluginPanelSupportsLocation(panel, location);
}

export function panelTargetSupportsHostForWorkspaceKey(
  workspaceKey: string,
  target: WorkspaceTabTarget,
  host: PaneHost,
): boolean {
  if (target.kind !== "plugin") return panelSupportsHost(target.kind, host);
  const serverId =
    pluginRegistry
      .getSnapshot()
      .filter((plugin) => plugin.id === target.pluginId)
      .map((plugin) => plugin.serverId)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => workspaceKey.startsWith(`${candidate}:`)) ?? "";
  return panelTargetSupportsHost(serverId, target, host);
}
