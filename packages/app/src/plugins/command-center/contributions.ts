import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import type { PluginCommandShortcut } from "@/keyboard/keyboard-shortcuts";
import { chordStringToShortcutKeys } from "@/keyboard/shortcut-string";
import { resolvePluginIcon } from "../icons";
import { resolvePluginPanelOpenLocation } from "../workspace-panels/locations";
import type { PluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";
import { createPluginCapabilities, type PluginNavigation } from "../actions";

export interface PluginCommandCenterSource {
  plugins: readonly InstalledPlugin[];
  runtime(plugin: InstalledPlugin): PluginSurfaceRuntime;
  state: PluginClientStateSource;
  workspaceId: string | null;
  agentId: string | null;
  navigation: PluginNavigation;
  reportError(error: unknown): void;
  /** Applies the user's rebinding. Returns null when they unassigned the keys. */
  resolveShortcutCombo?(bindingId: string, declared: string): string | null;
}

/** Namespaced so a plugin keybinding can never collide with a built-in binding id. */
export function pluginCommandBindingId(commandId: string): string {
  return `plugin:${commandId}`;
}

function resolveCombo(
  source: Pick<PluginCommandCenterSource, "resolveShortcutCombo">,
  commandId: string,
  declared: string | undefined,
): string | null {
  if (!declared?.trim()) return null;
  if (!source.resolveShortcutCombo) return declared;
  return source.resolveShortcutCombo(pluginCommandBindingId(commandId), declared);
}

function displayShortcutKeys(combo: string | null) {
  if (!combo) return undefined;
  try {
    return chordStringToShortcutKeys(combo);
  } catch {
    return undefined;
  }
}

/**
 * Keybindings for the items that are currently contributed. Built from the same contributions the
 * Command Center shows, so a command whose context disappeared loses its keys with its row.
 */
export function buildPluginCommandShortcuts(input: {
  plugins: readonly InstalledPlugin[];
  contributions: readonly CommandCenterContribution[];
  resolveShortcutCombo?: PluginCommandCenterSource["resolveShortcutCombo"];
}): Array<PluginCommandShortcut & { run: () => void | Promise<void> }> {
  const shortcuts: Array<PluginCommandShortcut & { run: () => void | Promise<void> }> = [];
  for (const plugin of input.plugins) {
    for (const item of plugin.commandCenterItems) {
      const commandId = `${plugin.id}:${item.id}`;
      const contribution = input.contributions.find((candidate) => candidate.id === commandId);
      if (!contribution) continue;
      const combo = resolveCombo(input, commandId, item.shortcut);
      if (!combo) continue;
      shortcuts.push({
        id: pluginCommandBindingId(commandId),
        commandId,
        combo,
        run: contribution.run,
      });
    }
  }
  return shortcuts;
}

export function buildPluginCommandCenterContributions(
  source: PluginCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  for (const plugin of source.plugins) {
    for (const [rank, item] of plugin.commandCenterItems.entries()) {
      if (item.context === "workspace" && !source.workspaceId) continue;
      if (item.context === "agent" && (!source.workspaceId || !source.agentId)) continue;
      const run = async () => {
        const runtime = source.runtime(plugin);
        const common = createPluginCapabilities(plugin, runtime, source.navigation);
        try {
          if (item.context === "global") {
            await item.onSelect({ context: "global", ...common });
            return;
          }
          const workspace = source.workspaceId
            ? source.state.getWorkspace(source.workspaceId)
            : null;
          if (!workspace) return;
          if (item.context === "workspace") {
            await item.onSelect({
              context: "workspace",
              ...common,
              workspace,
              openPanel(panelId, options) {
                const panel = plugin.workspacePanels.find(
                  (candidate) => candidate.id === panelId && candidate.context === "workspace",
                );
                if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
                const location = resolvePluginPanelOpenLocation(panel, options?.location);
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
              },
            });
            return;
          }
          const agent = source.agentId ? source.state.getAgent(source.agentId) : null;
          if (!agent) return;
          await item.onSelect({
            context: "agent",
            ...common,
            workspace,
            agent,
            openPanel(panelId, options) {
              const panel = plugin.workspacePanels.find((candidate) => candidate.id === panelId);
              if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
              const location = resolvePluginPanelOpenLocation(panel, options?.location);
              if (panel.context === "workspace") {
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
                return;
              }
              source.navigation.openAgentPanel(plugin.id, panelId, agent.id, location);
            },
          });
        } catch (error) {
          source.reportError(error);
        } finally {
          await runtime.paseo.dispose().catch(source.reportError);
        }
      };
      const commandId = `${plugin.id}:${item.id}`;
      const shortcutKeys = displayShortcutKeys(resolveCombo(source, commandId, item.shortcut));
      contributions.push({
        id: commandId,
        group: `plugin:${plugin.id}`,
        groupRank: 5,
        rank,
        keywords: item.keywords ?? [],
        visibility: "always",
        presentation: {
          kind: "action",
          title: item.title,
          sectionTitle: plugin.id,
          icon: getCommandCenterIcon(resolvePluginIcon(item.icon)),
          ...(shortcutKeys ? { shortcutKeys } : {}),
        },
        run,
      });
    }
  }
  return contributions;
}
