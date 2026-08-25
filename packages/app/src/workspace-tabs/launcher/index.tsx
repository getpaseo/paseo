import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  Files,
  GitPullRequest,
  Globe,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react-native";
import invariant from "tiny-invariant";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolvePluginIcon } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import { pluginPanelSupportsLocation } from "@/plugins/workspace-panels/locations";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { NewTabSelection } from "@/workspace-tabs/new-tab";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { panelSupportsHost, type PaneHost } from "@/panels/panel-manifest";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
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
  panelKind: WorkspaceTabTarget["kind"];
  launch: (destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchGroup {
  id: "tabs" | "plugin-panels" | "terminal-profiles";
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

const BUILT_IN_SELECTIONS: Record<BuiltInLaunchItemId, NewTabSelection> = {
  agent: { kind: "agent" },
  terminal: { kind: "terminal" },
  changes: { kind: "target", target: { kind: "changes_tree" } },
  files: { kind: "target", target: { kind: "files" } },
  browser: { kind: "browser" },
  pullRequest: { kind: "target", target: { kind: "pull_request" } },
};

export function useWorkspaceTabLaunchCatalog(input: {
  serverId: string;
  purpose: WorkspaceTabLaunchPurpose;
  host: PaneHost;
}): readonly WorkspaceTabLaunchGroup[] {
  const { serverId, purpose, host } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  const { config } = useDaemonConfig(serverId);
  const plugins = useInstalledPlugins();
  ensurePanelsRegistered();

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
    const changesTarget: Extract<WorkspaceTabTarget, { kind: "changes_tree" | "working_diff" }> =
      host === "explorer" ? { kind: "changes_tree" } : { kind: "working_diff" };
    const builtIns: Record<BuiltInLaunchItemId, WorkspaceTabLaunchItem & { hidden?: boolean }> = {
      agent: {
        id: "agent",
        label: t("workspace.tabs.fallback.agent"),
        Icon: SquarePen,
        shortcutActionId: "workspace-tab-target-agent",
        disabled: false,
        panelKind: "draft",
        launch: launchSelection(BUILT_IN_SELECTIONS.agent),
      },
      terminal: {
        id: "terminal",
        label: t("workspace.tabs.fallback.terminal"),
        Icon: SquareTerminal,
        shortcutActionId: "workspace-terminal-new",
        disabled: launcher.terminalDisabled,
        panelKind: "terminal",
        launch: launchSelection(BUILT_IN_SELECTIONS.terminal),
      },
      changes: {
        id: "changes",
        label: t("workspace.tabs.actions.changes"),
        Icon: FileDiff,
        shortcutActionId: "workspace-tab-target-changes",
        disabled: false,
        panelKind: changesTarget.kind,
        hidden: !launcher.showChanges,
        launch: launchSelection({ kind: "target", target: changesTarget }),
      },
      files: {
        id: "files",
        label: t("workspace.tabs.actions.files"),
        Icon: Files,
        shortcutActionId: "workspace-tab-target-files",
        disabled: false,
        panelKind: "files",
        launch: launchSelection(BUILT_IN_SELECTIONS.files),
      },
      browser: {
        id: "browser",
        label: t("workspace.tabs.fallback.browser"),
        Icon: Globe,
        shortcutActionId: "workspace-tab-target-browser",
        disabled: false,
        panelKind: "browser",
        hidden: !launcher.showBrowser,
        launch: launchSelection(BUILT_IN_SELECTIONS.browser),
      },
      pullRequest: {
        id: "pull-request",
        label: t("workspace.tabs.actions.pullRequest"),
        Icon: GitPullRequest,
        disabled: false,
        panelKind: "pull_request",
        hidden: !launcher.showPullRequest,
        launch: launchSelection(BUILT_IN_SELECTIONS.pullRequest),
      },
    };
    const tabItems = getBuiltInLaunchOrder(purpose).flatMap((id) => {
      const item = builtIns[id];
      return item.hidden || !panelSupportsHost(item.panelKind, host) ? [] : [item];
    });

    const pluginItems: WorkspaceTabLaunchItem[] = [];
    for (const plugin of plugins) {
      if (plugin.serverId !== serverId) continue;
      for (const panel of plugin.workspacePanels) {
        if (panel.context !== "workspace") continue;
        const location = host === "explorer" ? "explorer" : "workspace";
        if (!pluginPanelSupportsLocation(panel, location)) continue;
        const selection: NewTabSelection = {
          kind: "target",
          target: { kind: "plugin", pluginId: plugin.id, panelId: panel.id, context: "workspace" },
        };
        pluginItems.push({
          id: `plugin:${plugin.id}:${panel.id}`,
          label: panel.title,
          Icon: resolvePluginIcon(panel.icon),
          disabled: false,
          panelKind: "plugin",
          launch: launchSelection(selection),
        });
      }
    }

    const profiles = resolveTerminalProfiles(config?.terminalProfiles);
    const groups: WorkspaceTabLaunchGroup[] = [{ id: "tabs", label: null, items: tabItems }];
    if (pluginItems.length > 0) {
      groups.push({ id: "plugin-panels", label: null, items: pluginItems });
    }
    if (profiles.length > 0) {
      groups.push({
        id: "terminal-profiles",
        label: t("workspace.tabs.actions.terminalProfilesMenu"),
        items: profiles.map((profile: TerminalProfile) => ({
          id: `terminal-profile:${profile.id}`,
          label: profile.name,
          terminalIconKey: getTerminalProfileIcon(profile),
          disabled: launcher.terminalDisabled,
          panelKind: "terminal",
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
    config?.terminalProfiles,
    editTerminalProfiles,
    launchSelection,
    launcher,
    plugins,
    purpose,
    host,
    serverId,
    t,
  ]);
}

export { getBuiltInLaunchOrder } from "./internal/catalog";
