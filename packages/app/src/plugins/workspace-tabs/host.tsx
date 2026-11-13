import type {
  PluginSubagent,
  PluginSubagentMenuProps,
  PluginTabMenuProps,
  PluginTabPresentation,
  PluginWorkspaceTab,
} from "@getpaseo/plugin/client";
import type { WorkspaceRef } from "@getpaseo/plugin/client";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { queryClient } from "@/data/query-client";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { useWorkspaceTabActions } from "@/screens/workspace/use-workspace-tab-actions";
import { useWorkspaceTabClose } from "@/screens/workspace/use-workspace-tab-close";
import {
  useWorkspaceTabRename,
  WorkspaceTabRenameModal,
} from "@/screens/workspace/use-workspace-tab-rename";
import {
  buildWorkspaceTabActionEntries,
  type WorkspaceTabMenuEntry,
} from "@/screens/workspace/workspace-tab-menu";
import {
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useSubagentsForParent } from "@/subagents/select";
import { useSubagentRowPresentation } from "@/subagents/track";
import { useArchiveSubagent } from "@/subagents/use-archive-subagent";
import { useDetachSubagent } from "@/subagents/use-detach-subagent";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { registerWorkspaceTabsHost } from "./bridge";
import {
  createSubagentsProjector,
  createWorkspaceTabsProjector,
  NO_PLUGIN_WORKSPACE_TABS,
  readSubagentRow,
  selectWorkspaceTabDescriptors,
} from "./model";

function useWorkspaceTabs(workspace: WorkspaceRef) {
  const layoutKey = buildWorkspaceTabPersistenceKey({
    serverId: workspace.hostId,
    workspaceId: workspace.id,
  });
  const project = useMemo(() => createWorkspaceTabsProjector(workspace), [workspace]);
  // The selector reads only this workspace's layout, so another workspace's tab changes and
  // focus moves elsewhere cost a reference check, and an unchanged list keeps its identity.
  const select = useMemo(() => {
    let lastLayout: unknown;
    let lastExplorer: unknown;
    let last = NO_PLUGIN_WORKSPACE_TABS;
    return (state: ReturnType<typeof useWorkspaceLayoutStore.getState>) => {
      if (!layoutKey) return NO_PLUGIN_WORKSPACE_TABS;
      const layout = state.layoutByWorkspace[layoutKey] ?? null;
      const explorer = state.explorerSidebarPaneIdByWorkspace[layoutKey];
      if (layout === lastLayout && explorer === lastExplorer) return last;
      lastLayout = layout;
      lastExplorer = explorer;
      last = project(
        selectWorkspaceTabDescriptors({
          layout,
          explorerPaneId: selectExplorerSidebarPaneId(state, layoutKey),
        }),
      );
      return last;
    };
  }, [layoutKey, project]);
  return useWorkspaceLayoutStore(select);
}

function useSubagents(
  agent: PluginSubagent["parentAgent"],
  options?: { parentSubagentId?: string },
) {
  const rows = useSubagentsForParent({
    serverId: agent.hostId,
    parentAgentId: agent.id,
    providerParentSubagentId: options?.parentSubagentId,
  });
  const project = useMemo(
    () => createSubagentsProjector(agent.hostId, agent.id),
    [agent.hostId, agent.id],
  );
  return useMemo(() => project(rows), [project, rows]);
}

function toPluginPresentation(
  presentation: WorkspaceTabPresentation,
  subtitle = presentation.subtitle,
): PluginTabPresentation {
  return {
    label: presentation.label,
    subtitle,
    tooltip: presentation.tooltip,
    modified: presentation.modified,
    loading: presentation.titleState === "loading",
    indicator: presentation.statusBucket,
    Icon: presentation.icon,
  };
}

function useSubagentPresentation(subagent: PluginSubagent): PluginTabPresentation {
  const source = readSubagentRow(subagent);
  if (!source) throw new Error("Unknown subagent: read it with useSubagents");
  const { row, hostId } = source;
  const presentation = useSubagentRowPresentation(
    row,
    row.kind === "paseo" ? row.address.serverId : hostId,
  );
  // A Paseo subagent has no provider subtitle; the app shows its model and usage line instead.
  const facts = useAgentFactsLine(
    row.kind === "paseo" ? row.address.serverId : hostId,
    row.kind === "paseo" ? row.id : "",
  );
  const subtitle = row.kind === "paseo" ? (facts ?? "") : presentation.subtitle;
  return useMemo(() => toPluginPresentation(presentation, subtitle), [presentation, subtitle]);
}

/** The app's descriptor for a plugin tab, read live so menus act on the tab as it is now. */
function useTabDescriptor(tab: PluginWorkspaceTab): WorkspaceTabDescriptor | null {
  const layoutKey = buildWorkspaceTabPersistenceKey({
    serverId: tab.workspace.hostId,
    workspaceId: tab.workspace.id,
  });
  const target = useWorkspaceLayoutStore((state) => {
    const layout = layoutKey ? state.layoutByWorkspace[layoutKey] : undefined;
    if (!layout) return null;
    return collectAllTabs(layout.root).find((entry) => entry.tabId === tab.id)?.target ?? null;
  });
  return useMemo(
    () => (target ? { key: tab.id, tabId: tab.id, kind: target.kind, target } : null),
    [tab.id, target],
  );
}

function WorkspaceTabPresentation({
  tab,
  children,
}: {
  tab: PluginWorkspaceTab;
  children: (presentation: PluginTabPresentation) => ReactNode;
}) {
  // The workspace screen fills the registry, and a sidebar can render first.
  ensurePanelsRegistered();
  const descriptor = useTabDescriptor(tab);
  const render = useCallback(
    (presentation: WorkspaceTabPresentation) => children(toPluginPresentation(presentation)),
    [children],
  );
  if (!descriptor) return null;
  return (
    <WorkspaceTabPresentationResolver
      tab={descriptor}
      serverId={tab.workspace.hostId}
      workspaceId={tab.workspace.id}
    >
      {render}
    </WorkspaceTabPresentationResolver>
  );
}

function ignoreTabClosed(): void {}

/** Rename reads the terminal's current title from the list its tab's descriptor fetched. */
function useTabRename(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const terminalsQueryKey = useMemo(
    () => buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId),
    [serverId, workspaceDirectory, workspaceId],
  );
  const getTerminals = useCallback(
    () => queryClient.getQueryData<ListTerminalsResponse["payload"]>(terminalsQueryKey),
    [terminalsQueryKey],
  );
  return useWorkspaceTabRename({
    client,
    normalizedServerId: serverId,
    queryClient,
    getTerminals,
    terminalsQueryKey,
  });
}

function useTabMenuActions(serverId: string, workspaceId: string) {
  const tabActions = useWorkspaceTabActions(serverId);
  const { closeTabById } = useWorkspaceTabClose({
    serverId,
    workspaceId,
    onTabClosed: ignoreTabClosed,
  });
  const rename = useTabRename(serverId, workspaceId);
  const actions = useMemo(
    () => ({
      onCopyResumeCommand: tabActions.copyResumeCommand,
      onCopyAgentId: tabActions.copyAgentId,
      onCopyTerminalId: tabActions.copyTerminalId,
      onCopyFilePath: tabActions.copyFilePath,
      onReloadAgent: tabActions.reloadAgent,
      onRenameTab: rename.handleRenameTab,
      onCloseTab: closeTabById,
    }),
    [tabActions, rename.handleRenameTab, closeTabById],
  );
  return { actions, rename };
}

function WorkspaceTabMenu({ tab, label, testID }: PluginTabMenuProps) {
  const serverId = tab.workspace.hostId;
  const workspaceId = tab.workspace.id;
  const descriptor = useTabDescriptor(tab);
  const { actions, rename } = useTabMenuActions(serverId, workspaceId);
  const menuTestIDBase =
    testID ?? `plugin-tab-menu-${tab.workspace.hostId}-${tab.workspace.id}-${tab.id}`;
  const entries = useMemo(
    () =>
      descriptor
        ? buildWorkspaceTabActionEntries({ ...actions, tab: descriptor, menuTestIDBase })
        : [],
    [actions, descriptor, menuTestIDBase],
  );
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId: tab.id },
    menuTestIDBase,
  );
  if (!descriptor) return null;
  return (
    <>
      <MobileTabTrailingAccessory
        menuTestIDBase={menuTestIDBase}
        presentationLabel={label ?? ""}
        menuEntries={entries}
        openWith={openWith}
      />
      <WorkspaceTabRenameModal
        renamingTab={rename.renamingTab}
        onSubmit={rename.handleRenameModalSubmit}
        onClose={rename.handleRenameModalClose}
      />
    </>
  );
}

/**
 * Where a subagent's tab can be closed: the listing workspace when it holds the tab, otherwise
 * the subagent's own workspace. Null when neither layout has it.
 */
function useWorkspaceIdHoldingAgentTab(
  serverId: string,
  listingWorkspaceId: string,
  agentId: string,
): string | null {
  const tabId = buildDeterministicWorkspaceTabId({ kind: "agent", agentId });
  const ownWorkspaceId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.workspaceId ?? null;
  });
  return useWorkspaceLayoutStore((state) => {
    const holds = (workspaceId: string) => {
      const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!key) return false;
      if (state.sheetsByWorkspace[key]?.some((sheet) => sheet.tab.tabId === tabId)) return true;
      const layout = state.layoutByWorkspace[key];
      return layout ? collectAllTabs(layout.root).some((tab) => tab.tabId === tabId) : false;
    };
    if (holds(listingWorkspaceId)) return listingWorkspaceId;
    if (ownWorkspaceId && ownWorkspaceId !== listingWorkspaceId && holds(ownWorkspaceId)) {
      return ownWorkspaceId;
    }
    return null;
  });
}

function SubagentMenu({ subagent, workspace, label, testID }: PluginSubagentMenuProps) {
  // Only a Paseo subagent on the listing host has a tab, a lifecycle and an id to act on.
  if (subagent.kind !== "agent" || subagent.agent.hostId !== workspace.hostId) return null;
  return (
    <PaseoSubagentMenu
      agentId={subagent.agent.id}
      serverId={workspace.hostId}
      workspaceId={workspace.id}
      label={label ?? ""}
      menuTestIDBase={
        testID ?? `plugin-subagent-menu-${workspace.hostId}-${workspace.id}-${subagent.agent.id}`
      }
    />
  );
}

function PaseoSubagentMenu({
  agentId,
  serverId,
  workspaceId,
  label,
  menuTestIDBase,
}: {
  agentId: string;
  serverId: string;
  workspaceId: string;
  label: string;
  menuTestIDBase: string;
}) {
  const { t } = useTranslation();
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();
  const canDetach = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const holdingWorkspaceId = useWorkspaceIdHoldingAgentTab(serverId, workspaceId, agentId);
  const { actions, rename } = useTabMenuActions(serverId, holdingWorkspaceId ?? workspaceId);
  const entries = useMemo<WorkspaceTabMenuEntry[]>(() => {
    const tabId = buildDeterministicWorkspaceTabId({ kind: "agent", agentId });
    const tab: WorkspaceTabDescriptor = {
      key: tabId,
      tabId,
      kind: "agent",
      target: { kind: "agent", agentId },
    };
    const address = { serverId, agentId };
    const tabEntries = buildWorkspaceTabActionEntries({ ...actions, tab, menuTestIDBase });
    const lifecycle: WorkspaceTabMenuEntry[] = [];
    if (canDetach) {
      lifecycle.push({
        kind: "item",
        key: "detach-subagent",
        label: t("subagents.detachTooltip"),
        icon: "unlink",
        testID: `${menuTestIDBase}-detach`,
        onSelect: () => detachSubagent(address),
      });
    }
    lifecycle.push({
      kind: "item",
      key: "archive-subagent",
      label: t("subagents.archiveTooltip"),
      icon: "archive",
      destructive: true,
      testID: `${menuTestIDBase}-archive`,
      onSelect: () => archiveSubagent(address),
    });
    // With no open tab there is nothing to close.
    const own = holdingWorkspaceId
      ? tabEntries
      : tabEntries.filter((entry) => entry.key !== "close" && entry.key !== "close-separator");
    return [...own, { kind: "separator", key: "subagent-lifecycle-separator" }, ...lifecycle];
  }, [
    actions,
    agentId,
    archiveSubagent,
    canDetach,
    detachSubagent,
    holdingWorkspaceId,
    menuTestIDBase,
    serverId,
    t,
  ]);
  return (
    <>
      <MobileTabTrailingAccessory
        menuTestIDBase={menuTestIDBase}
        presentationLabel={label}
        menuEntries={entries}
      />
      <WorkspaceTabRenameModal
        renamingTab={rename.renamingTab}
        onSubmit={rename.handleRenameModalSubmit}
        onClose={rename.handleRenameModalClose}
      />
    </>
  );
}

/** Makes the workspace tab hooks and components plugin code reaches through the bridge live. */
export function installWorkspaceTabsHost(): void {
  registerWorkspaceTabsHost({
    useWorkspaceTabs,
    useSubagents,
    useSubagentPresentation,
    WorkspaceTabPresentation,
    WorkspaceTabMenu,
    SubagentMenu,
  });
}
