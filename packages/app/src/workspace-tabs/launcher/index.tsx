import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Globe, SquarePen, SquareTerminal } from "@/components/icons/ui-icons";
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
import {
  getPanelRegistration,
  type PanelIconProps,
  type PanelPresentation,
} from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { getBuiltInLaunchOrder, type BuiltInLaunchItemId } from "./internal/catalog";
import type { TFunction } from "i18next";
import {
  useRecentlyClosedTabsStore,
  type ClosedTabEntry,
  type ReopenableTabTarget,
} from "@/stores/recently-closed-tabs-store";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

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
  /** Scopes the recently closed tabs to this workspace. */
  workspaceKey?: string | null;
}

export interface WorkspaceTabLaunchItem {
  id: string;
  label: string;
  Icon?: ComponentType<PanelIconProps>;
  terminalIconKey?: string;
  shortcutActionId?: string;
  disabled: boolean;
  panelKind: WorkspaceTabTarget["kind"];
  /** The fixed view this item can toggle in a configuration menu, or null for launch-only items. */
  toggleTarget: WorkspaceTabTarget | null;
  launch: (destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchGroup {
  id: "tabs" | "plugin-panels" | "terminal-profiles" | "recently-closed" | "recently-closed-chats";
  label: string | null;
  items: readonly WorkspaceTabLaunchItem[];
  accessory?: { id: string; label: string; run: () => void };
}

const NewTabLauncherContext = createContext<NewTabLauncher | null>(null);

const CLOSED_TAB_ICONS: Record<ReopenableTabTarget["kind"], ComponentType<PanelIconProps>> = {
  agent: SquarePen,
  terminal: SquareTerminal,
  browser: Globe,
};

function closedTabLabel(
  entry: ClosedTabEntry,
  t: TFunction,
  agents: ReadonlyMap<string, { title?: string | null }> | undefined,
): string {
  const target = entry.target;
  if (target.kind === "agent") {
    return (
      agents?.get(target.agentId)?.title?.trim() ||
      entry.title ||
      t("workspace.tabs.fallback.agent")
    );
  }
  if (target.kind === "browser")
    return entry.title || entry.url || t("workspace.tabs.fallback.browser");
  return t("workspace.tabs.fallback.terminal");
}

/** A closed agent reopens as itself; a browser tab at its last page; a terminal fresh. */
function reopenSelection(entry: ClosedTabEntry): NewTabSelection {
  if (entry.target.kind === "agent") return { kind: "target", target: entry.target };
  if (entry.target.kind === "browser")
    return { kind: "browser", ...(entry.url ? { url: entry.url } : {}) };
  return { kind: "terminal" };
}

export function NewTabLauncherProvider({
  value,
  children,
}: {
  value: NewTabLauncher;
  children: ReactNode;
}) {
  return <NewTabLauncherContext.Provider value={value}>{children}</NewTabLauncherContext.Provider>;
}

const BUILT_IN_SELECTIONS = {
  agent: { kind: "agent" },
  terminal: { kind: "terminal" },
  changes: { kind: "target", target: { kind: "changes_tree" } },
  diff: { kind: "target", target: { kind: "working_diff" } },
  files: { kind: "target", target: { kind: "files" } },
  browser: { kind: "browser" },
  pullRequest: { kind: "target", target: { kind: "pull_request" } },
  evidence: { kind: "target", target: { kind: "evidence" } },
  insights: { kind: "target", target: { kind: "insights" } },
} satisfies Record<BuiltInLaunchItemId, NewTabSelection>;

function getLaunchPresentation(kind: WorkspaceTabTarget["kind"]): PanelPresentation {
  const registration = getPanelRegistration(kind);
  invariant(registration?.presentation, `Panel ${kind} has no launch presentation`);
  return registration.presentation;
}

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
  const closedByWorkspace = useRecentlyClosedTabsStore((state) => state.byWorkspace);
  const forgetClosed = useRecentlyClosedTabsStore((state) => state.forget);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  // Only what was closed here. Closing archives a session and reopening brings it back,
  // like History does; a session that has since moved to another workspace drops out.
  const recentlyClosed = useMemo(
    () =>
      (launcher.workspaceKey ? (closedByWorkspace[launcher.workspaceKey] ?? []) : []).filter(
        (entry) => {
          if (entry.target.kind !== "agent") return true;
          const agent = agents?.get(entry.target.agentId);
          return (
            !agent?.workspaceId || launcher.workspaceKey?.endsWith(`:${agent.workspaceId}`) === true
          );
        },
      ),
    [agents, closedByWorkspace, launcher.workspaceKey],
  );
  const editTerminalProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals") as Href);
  }, [router, serverId]);

  return useMemo(() => {
    const changesPresentation = getLaunchPresentation("changes_tree");
    const diffPresentation = getLaunchPresentation("working_diff");
    const filesPresentation = getLaunchPresentation("files");
    const pullRequestPresentation = getLaunchPresentation("pull_request");
    const evidencePresentation = getLaunchPresentation("evidence");
    const insightsPresentation = getLaunchPresentation("insights");
    const builtIns: Record<BuiltInLaunchItemId, WorkspaceTabLaunchItem & { hidden?: boolean }> = {
      agent: {
        id: "agent",
        label: t("workspace.tabs.fallback.agent"),
        Icon: SquarePen,
        shortcutActionId: "workspace-tab-target-agent",
        disabled: false,
        panelKind: "draft",
        toggleTarget: null,
        launch: launchSelection(BUILT_IN_SELECTIONS.agent),
      },
      terminal: {
        id: "terminal",
        label: t("workspace.tabs.fallback.terminal"),
        Icon: SquareTerminal,
        shortcutActionId: "workspace-terminal-new",
        disabled: launcher.terminalDisabled,
        panelKind: "terminal",
        toggleTarget: null,
        launch: launchSelection(BUILT_IN_SELECTIONS.terminal),
      },
      changes: {
        id: "changes",
        label: changesPresentation.label(t),
        Icon: changesPresentation.icon,
        disabled: false,
        panelKind: "changes_tree",
        toggleTarget: BUILT_IN_SELECTIONS.changes.target,
        hidden: !launcher.showChanges,
        launch: launchSelection(BUILT_IN_SELECTIONS.changes),
      },
      diff: {
        id: "diff",
        label: diffPresentation.label(t),
        Icon: diffPresentation.icon,
        shortcutActionId: "workspace-tab-target-changes",
        disabled: false,
        panelKind: "working_diff",
        toggleTarget: null,
        hidden: !launcher.showChanges,
        launch: launchSelection(BUILT_IN_SELECTIONS.diff),
      },
      files: {
        id: "files",
        label: filesPresentation.label(t),
        Icon: filesPresentation.icon,
        shortcutActionId: "workspace-tab-target-files",
        disabled: false,
        panelKind: "files",
        toggleTarget: BUILT_IN_SELECTIONS.files.target,
        launch: launchSelection(BUILT_IN_SELECTIONS.files),
      },
      browser: {
        id: "browser",
        label: t("workspace.tabs.fallback.browser"),
        Icon: Globe,
        shortcutActionId: "workspace-tab-target-browser",
        disabled: false,
        panelKind: "browser",
        toggleTarget: null,
        hidden: !launcher.showBrowser,
        launch: launchSelection(BUILT_IN_SELECTIONS.browser),
      },
      pullRequest: {
        id: "pull-request",
        label: pullRequestPresentation.label(t),
        Icon: pullRequestPresentation.icon,
        disabled: false,
        panelKind: "pull_request",
        toggleTarget: null,
        hidden: !launcher.showPullRequest,
        launch: launchSelection(BUILT_IN_SELECTIONS.pullRequest),
      },
      evidence: {
        id: "evidence",
        label: evidencePresentation.label(t),
        Icon: evidencePresentation.icon,
        disabled: false,
        panelKind: "evidence",
        toggleTarget: BUILT_IN_SELECTIONS.evidence.target,
        launch: launchSelection(BUILT_IN_SELECTIONS.evidence),
      },
      insights: {
        id: "insights",
        label: insightsPresentation.label(t),
        Icon: insightsPresentation.icon,
        disabled: false,
        panelKind: "insights",
        toggleTarget: BUILT_IN_SELECTIONS.insights.target,
        launch: launchSelection(BUILT_IN_SELECTIONS.insights),
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
          toggleTarget: selection.target,
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
          toggleTarget: null,
          launch: launchSelection({ kind: "terminal", profile }),
        })),
        accessory: {
          id: "edit-terminal-profiles",
          label: t("workspace.tabs.actions.editTerminalProfiles"),
          run: editTerminalProfiles,
        },
      });
    }
    const closedItem = (entry: (typeof recentlyClosed)[number]) => ({
      id: `recently-closed:${entry.id}`,
      label: closedTabLabel(entry, t, agents),
      Icon: CLOSED_TAB_ICONS[entry.target.kind],
      disabled: entry.target.kind === "terminal" && launcher.terminalDisabled,
      panelKind: entry.target.kind,
      toggleTarget: null,
      launch: (destination: WorkspaceTabLaunchDestination) => {
        if (launcher.workspaceKey) forgetClosed(launcher.workspaceKey, entry.id);
        // Closing archived the session; bring it back like the Unarchive button does,
        // or the tab opens on an archived, possibly empty session.
        if (entry.target.kind === "agent") {
          void getHostRuntimeStore()
            .getClient(serverId)
            ?.refreshAgent(entry.target.agentId)
            .catch(() => undefined);
        }
        launcher.launch(reopenSelection(entry), destination);
      },
    });
    const closedChats = recentlyClosed.filter((entry) => entry.target.kind === "agent");
    const closedTabs = recentlyClosed.filter((entry) => entry.target.kind !== "agent");
    if (closedChats.length > 0) {
      groups.push({
        id: "recently-closed-chats",
        label: t("workspace.tabs.actions.recentlyClosedChats"),
        items: closedChats.map(closedItem),
      });
    }
    if (closedTabs.length > 0) {
      groups.push({
        id: "recently-closed",
        label: t("workspace.tabs.actions.recentlyClosed"),
        items: closedTabs.map(closedItem),
      });
    }
    return groups;
  }, [
    agents,
    recentlyClosed,
    forgetClosed,
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
