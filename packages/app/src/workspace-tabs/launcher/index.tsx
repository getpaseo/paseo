import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  Globe,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react-native";
import equal from "fast-deep-equal";
import invariant from "tiny-invariant";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolvePluginIcon } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectAgentExistsInWorkspace, useWorkspaceExists } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { NewTabSelection } from "@/workspace-tabs/new-tab";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { resolveLauncherAgentCandidates } from "./internal/agent-context";
import { getBuiltInLaunchOrder, type BuiltInLaunchItemId } from "./internal/catalog";

export type WorkspaceTabLaunchPurpose = "primary" | "supporting";

export type WorkspaceTabLaunchDestination =
  | { kind: "open"; paneId?: string }
  | { kind: "replace"; tabId: string };

export interface NewTabLauncher {
  showChanges: boolean;
  showPullRequest: boolean;
  showBrowser: boolean;
  terminalDisabled: boolean;
  launch: (selection: NewTabSelection, destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchItem {
  id: string;
  label: string;
  Icon?: LucideIcon;
  terminalIconKey?: string;
  shortcutActionId?: string;
  disabled: boolean;
  launch: (destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchGroup {
  id: "tabs" | "terminal-profiles";
  label: string | null;
  items: readonly WorkspaceTabLaunchItem[];
  accessory?: { id: string; label: string; run: () => void };
}

const NewTabLauncherContext = createContext<NewTabLauncher | null>(null);

export function NewTabLauncherProvider({
  value,
  children,
}: {
  value: NewTabLauncher;
  children: ReactNode;
}) {
  return <NewTabLauncherContext.Provider value={value}>{children}</NewTabLauncherContext.Provider>;
}

function pluginPanelSelection(
  pluginId: string,
  panel: PluginWorkspacePanelContribution,
  agentId: string | null,
): NewTabSelection | null {
  if (panel.context === "workspace") {
    return {
      kind: "target",
      target: { kind: "plugin", pluginId, panelId: panel.id, context: "workspace" },
    };
  }
  // The agent identity is resolved again at launch time; agentId only gates
  // visibility here.
  return agentId ? { kind: "plugin-agent-panel", pluginId, panelId: panel.id } : null;
}

const NO_AGENT_CANDIDATES: string[] = [];

/**
 * The agent an agent-context plugin panel would bind to right now, or null when
 * the workspace has no open agent. Uses the shared membership rule
 * (`selectAgentExistsInWorkspace`) so the launcher cannot offer a panel that
 * `PluginPanelBody` would refuse to render, and applies it per candidate so one
 * stale tab reference cannot hide panels while a live agent is open. Both
 * selectors return primitives, so layout and session churn that leaves the
 * answer unchanged re-renders nothing.
 */
function useLaunchAgentId(serverId: string, workspaceId: string, enabled: boolean): string | null {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const candidates = useStoreWithEqualityFn(
    useWorkspaceLayoutStore,
    (state) =>
      enabled && workspaceKey
        ? resolveLauncherAgentCandidates(state.layoutByWorkspace[workspaceKey] ?? null)
        : NO_AGENT_CANDIDATES,
    equal,
  );
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      candidates.find((agentId) =>
        selectAgentExistsInWorkspace(state, serverId, workspaceId, agentId),
      ) ?? null,
    Object.is,
  );
}

const BUILT_IN_SELECTIONS: Record<BuiltInLaunchItemId, NewTabSelection> = {
  agent: { kind: "agent" },
  terminal: { kind: "terminal" },
  changes: { kind: "target", target: { kind: "working_diff" } },
  files: { kind: "target", target: { kind: "files" } },
  browser: { kind: "browser" },
  pullRequest: { kind: "target", target: { kind: "pull_request" } },
};

export function useWorkspaceTabLaunchCatalog(input: {
  serverId: string;
  workspaceId: string;
  purpose: WorkspaceTabLaunchPurpose;
}): readonly WorkspaceTabLaunchGroup[] {
  const { serverId, workspaceId, purpose } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  const { config } = useDaemonConfig(serverId);
  const plugins = useInstalledPlugins();
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const runtimeClient = useHostRuntimeClient(serverId);
  // Mirror PluginPanelBody's refusal conditions: it renders "unavailable" when
  // the workspace is gone and "host is offline" without a runtime client.
  const pluginsAvailable = workspaceExists && runtimeClient !== null;
  const hasAgentPanels = plugins.some(
    (plugin) =>
      plugin.serverId === serverId &&
      plugin.workspacePanels.some((panel) => panel.context === "agent"),
  );
  const agentId = useLaunchAgentId(serverId, workspaceId, hasAgentPanels);

  const launchSelection = useCallback(
    (selection: NewTabSelection) => (destination: WorkspaceTabLaunchDestination) => {
      launcher.launch(selection, destination);
    },
    [launcher],
  );
  const editTerminalProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals") as Href);
  }, [router, serverId]);

  return useMemo(() => {
    const builtIns: Record<BuiltInLaunchItemId, WorkspaceTabLaunchItem & { hidden?: boolean }> = {
      agent: {
        id: "agent",
        label: t("workspace.tabs.fallback.agent"),
        Icon: SquarePen,
        shortcutActionId: "workspace-tab-target-agent",
        disabled: false,
        launch: launchSelection(BUILT_IN_SELECTIONS.agent),
      },
      terminal: {
        id: "terminal",
        label: t("workspace.tabs.fallback.terminal"),
        Icon: SquareTerminal,
        shortcutActionId: "workspace-terminal-new",
        disabled: launcher.terminalDisabled,
        launch: launchSelection(BUILT_IN_SELECTIONS.terminal),
      },
      changes: {
        id: "changes",
        label: t("workspace.tabs.actions.changes"),
        Icon: FileDiff,
        shortcutActionId: "workspace-tab-target-changes",
        disabled: false,
        hidden: !launcher.showChanges,
        launch: launchSelection(BUILT_IN_SELECTIONS.changes),
      },
      files: {
        id: "files",
        label: t("workspace.tabs.actions.files"),
        Icon: FolderTree,
        shortcutActionId: "workspace-tab-target-files",
        disabled: false,
        launch: launchSelection(BUILT_IN_SELECTIONS.files),
      },
      browser: {
        id: "browser",
        label: t("workspace.tabs.fallback.browser"),
        Icon: Globe,
        shortcutActionId: "workspace-tab-target-browser",
        disabled: false,
        hidden: !launcher.showBrowser,
        launch: launchSelection(BUILT_IN_SELECTIONS.browser),
      },
      pullRequest: {
        id: "pull-request",
        label: t("workspace.tabs.actions.pullRequest"),
        Icon: GitPullRequest,
        disabled: false,
        hidden: !launcher.showPullRequest,
        launch: launchSelection(BUILT_IN_SELECTIONS.pullRequest),
      },
    };
    const tabItems = getBuiltInLaunchOrder(purpose).flatMap((id) => {
      const item = builtIns[id];
      return item.hidden ? [] : [item];
    });

    if (pluginsAvailable) {
      for (const plugin of plugins) {
        if (plugin.serverId !== serverId) continue;
        for (const panel of plugin.workspacePanels) {
          const selection = pluginPanelSelection(plugin.id, panel, agentId);
          // An agent panel with no agent to bind to is skipped rather than
          // disabled: the row would open a tab that can only say "unavailable".
          if (!selection) continue;
          tabItems.push({
            id: `plugin:${plugin.id}:${panel.id}`,
            label: panel.title,
            Icon: resolvePluginIcon(panel.icon),
            disabled: false,
            launch: launchSelection(selection),
          });
        }
      }
    }

    const profiles = resolveTerminalProfiles(config?.terminalProfiles);
    const groups: WorkspaceTabLaunchGroup[] = [{ id: "tabs", label: null, items: tabItems }];
    if (profiles.length > 0) {
      groups.push({
        id: "terminal-profiles",
        label: t("workspace.tabs.actions.terminalProfilesMenu"),
        items: profiles.map((profile: TerminalProfile) => ({
          id: `terminal-profile:${profile.id}`,
          label: profile.name,
          terminalIconKey: getTerminalProfileIcon(profile),
          disabled: launcher.terminalDisabled,
          launch: launchSelection({ kind: "terminal", profile }),
        })),
        accessory: {
          id: "edit-terminal-profiles",
          label: t("workspace.tabs.actions.editTerminalProfiles"),
          run: editTerminalProfiles,
        },
      });
    }
    return groups;
  }, [
    agentId,
    config?.terminalProfiles,
    editTerminalProfiles,
    launchSelection,
    launcher,
    plugins,
    pluginsAvailable,
    purpose,
    serverId,
    t,
  ]);
}

export { getBuiltInLaunchOrder } from "./internal/catalog";
export { resolveLauncherAgentId } from "./internal/agent-context";
