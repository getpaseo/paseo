import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { mapLayout } from "@/components/ui/control-geometry";
import { isNative, isWeb } from "@/constants/platform";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { queryClient } from "@/data/query-client";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { useWorkspaceTabActions } from "@/screens/workspace/use-workspace-tab-actions";
import {
  useWorkspaceTabRename,
  WorkspaceTabRenameModal,
} from "@/screens/workspace/use-workspace-tab-rename";
import { buildWorkspaceTabActionEntries } from "@/screens/workspace/workspace-tab-menu";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { density, densityIconBox } from "@/styles/density";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { useHasSubagents, useSubagentsForParent, type SubagentRow } from "@/subagents/select";
import { useSubagentRowPresentation } from "@/subagents/track";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { selectPrHintFromStatus } from "@/git/pr-hint";
import { useWorkspaceLabelDefinitions } from "@/workspace-labels";
import {
  selectWorkspaceServiceSummary,
  WorkspaceMetaRow,
} from "@/components/sidebar/workspace-meta-row";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import { SidebarCountDisclosure } from "./disclosure";
import {
  toggleSidebarTabSubagents,
  useIsSidebarTabSubagentsExpanded,
  useIsSidebarWorkspaceTabsExpanded,
} from "./expansion";
import {
  hasSidebarWorkspaceTabsDisclosure,
  isSubagentTarget,
  summarizeSidebarWorkspaceTabs,
} from "./model";
import { useNestedSubagentTabIds, useSidebarWorkspaceTabs } from "./use-workspace-tabs";

interface SidebarWorkspaceTabsProps {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  /** Status-group rows indent from their header, so their tabs do too. */
  inStatusGroup?: boolean;
}

/** The open tabs of a workspace, under its sidebar row while the row is expanded. */
export function SidebarWorkspaceTabs(props: SidebarWorkspaceTabsProps) {
  const expanded = useIsSidebarWorkspaceTabsExpanded(props.workspaceKey);
  if (!expanded) return null;
  return <SidebarWorkspaceTabList {...props} />;
}

function SidebarWorkspaceTabList({
  serverId,
  workspaceId,
  workspaceKey,
  inStatusGroup = false,
}: SidebarWorkspaceTabsProps) {
  // The registry is filled by the workspace screen, and the sidebar can render first: a cold
  // load of /open-project or Settings with saved tabs would otherwise throw in the resolver.
  ensurePanelsRegistered();
  const sidebarTabs = useSidebarWorkspaceTabs(serverId, workspaceId);
  const { tabs, activeTabId } = sidebarTabs;
  const { soleAgentId } = summarizeSidebarWorkspaceTabs(sidebarTabs);
  const soleTabHasSubagents = useHasSubagents(serverId, soleAgentId);
  const activeTarget = tabs.find((tab) => tab.tabId === activeTabId)?.target ?? null;
  const tabActions = useWorkspaceTabActions(serverId);
  const rename = useSidebarWorkspaceTabRename(serverId, workspaceId);
  const menuActions = useMemo<SidebarWorkspaceTabMenuActions>(
    () => ({
      onCopyResumeCommand: tabActions.copyResumeCommand,
      onCopyAgentId: tabActions.copyAgentId,
      onCopyTerminalId: tabActions.copyTerminalId,
      onCopyFilePath: tabActions.copyFilePath,
      onReloadAgent: tabActions.reloadAgent,
      onRenameTab: rename.handleRenameTab,
    }),
    [tabActions, rename.handleRenameTab],
  );
  // A subagent's own tab is listed under its parent's tab rather than beside it.
  const nestedTabIds = useNestedSubagentTabIds(serverId, tabs);
  const topLevelTabs = useMemo(
    () => (nestedTabIds.size === 0 ? tabs : tabs.filter((tab) => !nestedTabIds.has(tab.tabId))),
    [nestedTabIds, tabs],
  );
  // The disclosure leaves with the second-to-last tab, unless that tab has subagents; the list
  // goes with it, and comes back expanded when the disclosure does.
  if (!hasSidebarWorkspaceTabsDisclosure(tabs.length, soleTabHasSubagents)) return null;

  return (
    <View
      style={inStatusGroup ? styles.listInStatusGroup : styles.list}
      testID={`sidebar-workspace-tabs-${workspaceKey}`}
    >
      {topLevelTabs.map((tab) => (
        <WorkspaceTabPresentationResolver
          key={tab.key}
          tab={tab}
          serverId={serverId}
          workspaceId={workspaceId}
        >
          {(presentation) =>
            tab.target.kind === "agent" ? (
              <SidebarAgentTabEntry
                tab={tab}
                agentId={tab.target.agentId}
                presentation={presentation}
                active={tab.tabId === activeTabId}
                activeTarget={activeTarget}
                serverId={serverId}
                workspaceId={workspaceId}
                workspaceKey={workspaceKey}
                menuActions={menuActions}
              />
            ) : (
              <SidebarWorkspaceTabRow
                tab={tab}
                presentation={presentation}
                active={tab.tabId === activeTabId}
                serverId={serverId}
                workspaceId={workspaceId}
                workspaceKey={workspaceKey}
                menuActions={menuActions}
              />
            )
          }
        </WorkspaceTabPresentationResolver>
      ))}
      <WorkspaceTabRenameModal
        renamingTab={rename.renamingTab}
        onSubmit={rename.handleRenameModalSubmit}
        onClose={rename.handleRenameModalClose}
      />
    </View>
  );
}

type SidebarWorkspaceTabMenuActions = Omit<
  Parameters<typeof buildWorkspaceTabActionEntries>[0],
  "tab" | "menuTestIDBase" | "labels"
>;

/** Rename reads the terminal's current title from the list its tab's descriptor fetched. */
function useSidebarWorkspaceTabRename(serverId: string, workspaceId: string) {
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

/**
 * Opens the workspace on this tab. The tab is revealed by id rather than passed as a navigation
 * target: a target re-resolves placement and can open a compact sheet beside the tab that is
 * already there, while the id names the very tab the row lists — the same reveal the compact
 * tab switcher makes. Revealing after navigating also picks the panel: the explorer for its own
 * tabs on compact, the workspace otherwise, which closes the mobile menu.
 */
function openWorkspaceTab(input: { serverId: string; workspaceId: string; tabId: string }): void {
  navigateToWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
  const layoutKey = buildWorkspaceTabPersistenceKey(input);
  if (layoutKey) revealWorkspaceTab(layoutKey, input.tabId);
}

function SidebarWorkspaceTabRow({
  tab,
  presentation,
  active,
  serverId,
  workspaceId,
  workspaceKey,
  menuActions,
  trailing,
}: {
  tab: WorkspaceTabDescriptor;
  presentation: WorkspaceTabPresentation;
  active: boolean;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  menuActions: SidebarWorkspaceTabMenuActions;
  /** Beside the row's pressable, before the menu, so a button there presses on its own. */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(
    () => openWorkspaceTab({ serverId, workspaceId, tabId: tab.tabId }),
    [serverId, workspaceId, tab.tabId],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const label =
    presentation.titleState === "loading" ? t("workspace.tabs.loading") : presentation.label;
  const menuTestIDBase = `sidebar-workspace-tab-menu-${workspaceKey}-${tab.tabId}`;
  const menuEntries = useMemo(
    () => buildWorkspaceTabActionEntries({ ...menuActions, tab, menuTestIDBase }),
    [menuActions, tab, menuTestIDBase],
  );
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId: tab.tabId },
    menuTestIDBase,
  );
  // Hover-revealed on pointer; touch has no hover, so the menu is always there. It hides by
  // opacity rather than unmounting, so an open menu keeps its trigger when the pointer leaves.
  const showMenu = isHovered || isNative || isCompact;
  const emphasized = active || isHovered;
  return (
    <View
      style={isHovered ? styles.tabRowHovered : styles.tabRow}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        style={styles.tabRowPress}
        highlightStyle={styles.rowPressed}
        onPress={handlePress}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityState={accessibilityState}
        aria-selected={active}
        accessibilityLabel={label}
        testID={`sidebar-workspace-tab-${workspaceKey}-${tab.tabId}`}
      >
        <View style={styles.iconSlot}>
          <WorkspaceTabIcon
            presentation={presentation}
            active={emphasized}
            backdrop={isHovered ? "surfaceSidebarHover" : "surfaceSidebar"}
          />
        </View>
        <Text numberOfLines={1} style={emphasized ? styles.labelEmphasized : styles.label}>
          {label}
        </Text>
        {presentation.modified ? (
          <View style={styles.modifiedDot} accessibilityLabel={t("workspace.tabs.modified")} />
        ) : null}
      </PressHighlight>
      {trailing}
      {menuEntries.length > 0 ? (
        <View
          style={showMenu ? styles.menuSlot : styles.menuSlotHidden}
          pointerEvents={showMenu ? "auto" : "none"}
        >
          <MobileTabTrailingAccessory
            menuTestIDBase={menuTestIDBase}
            presentationLabel={label}
            menuEntries={menuEntries}
            openWith={openWith}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * An agent tab, with its subagents behind a disclosure of their own: the same children the
 * agent's subagents track lists, one level deep. Each opened child shows its own track.
 */
function SidebarAgentTabEntry({
  tab,
  agentId,
  presentation,
  active,
  activeTarget,
  serverId,
  workspaceId,
  workspaceKey,
  menuActions,
}: {
  tab: WorkspaceTabDescriptor;
  agentId: string;
  presentation: WorkspaceTabPresentation;
  active: boolean;
  activeTarget: WorkspaceTabTarget | null;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  menuActions: SidebarWorkspaceTabMenuActions;
}) {
  const { t } = useTranslation();
  const rows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const expanded = useIsSidebarTabSubagentsExpanded(workspaceKey, tab.tabId);
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const handleToggle = useCallback(
    () => toggleSidebarTabSubagents(workspaceKey, tab.tabId),
    [workspaceKey, tab.tabId],
  );
  const hasSubagents = rows.length > 0;
  // A focused child tab sits under this row rather than at the top level, so while the list is
  // collapsed the parent carries its highlight; expanded, the child's own row does.
  const childActive = useMemo(
    () => !expanded && rows.some((row) => isSubagentTarget(activeTarget, row)),
    [activeTarget, expanded, rows],
  );
  const trailing = useMemo(
    () =>
      hasSubagents ? (
        <SidebarCountDisclosure
          variant="tab"
          count={rows.length}
          expanded={expanded}
          onPress={handleToggle}
          accessibilityLabel={
            expanded
              ? t("sidebar.workspace.actions.hideSubagents")
              : t("sidebar.workspace.actions.showSubagents")
          }
          testID={`sidebar-workspace-tab-subagents-disclosure-${workspaceKey}-${tab.tabId}`}
        />
      ) : null,
    [expanded, handleToggle, hasSubagents, rows.length, t, tab.tabId, workspaceKey],
  );
  return (
    <>
      <SidebarWorkspaceTabRow
        tab={tab}
        presentation={presentation}
        active={active || childActive}
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
        menuActions={menuActions}
        trailing={trailing}
      />
      {expanded && hasSubagents ? (
        <View
          style={styles.subagentList}
          testID={`sidebar-workspace-tab-subagents-${workspaceKey}-${tab.tabId}`}
        >
          {rows.map((row) => (
            <SidebarSubagentRow
              key={row.kind === "paseo" ? `${row.address.serverId}:${row.id}` : row.id}
              row={row}
              active={isSubagentTarget(activeTarget, row)}
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceKey={workspaceKey}
              parentTabId={tab.tabId}
              openInSidePane={openInSidePane}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

/**
 * Opens a subagent the way its parent's track does, from outside the workspace. The parent tab is
 * revealed first so the child lands in the parent's pane, or in a sheet over the parent on
 * compact. A sheet reveals itself without picking the panel, so the mobile menu is closed here.
 * A Paseo subagent that lives in another workspace or host opens there instead.
 */
function openSidebarSubagent(input: {
  serverId: string;
  workspaceId: string;
  parentTabId: string;
  row: SubagentRow;
  openInSidePane: OpenInSidePanePreferences;
}): void {
  const { serverId, workspaceId, parentTabId, row } = input;
  if (row.kind === "paseo") {
    const { serverId: targetServerId, agentId } = row.address;
    const session = useSessionStore.getState().sessions[targetServerId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (targetServerId !== serverId || (agent?.workspaceId && agent.workspaceId !== workspaceId)) {
      navigateToAgent(row.address);
      return;
    }
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) return;
  navigateToWorkspace({ serverId, workspaceId });
  revealWorkspaceTab(workspaceKey, parentTabId);
  const target: WorkspaceTabTarget =
    row.kind === "paseo"
      ? { kind: "agent", agentId: row.id }
      : { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id };
  openPreferredWorkspaceTarget({
    workspaceKey,
    target,
    source: "subagents",
    preferences: input.openInSidePane,
    parentTabId,
  });
  if (useWorkspaceLayoutStore.getState().layoutMode === "compact") {
    usePanelStore.getState().showMobileAgent();
  }
}

function SidebarSubagentRow({
  row,
  active,
  serverId,
  workspaceId,
  workspaceKey,
  parentTabId,
  openInSidePane,
}: {
  row: SubagentRow;
  active: boolean;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  parentTabId: string;
  openInSidePane: OpenInSidePanePreferences;
}) {
  const { t } = useTranslation();
  const rowServerId = row.kind === "paseo" ? row.address.serverId : serverId;
  const presentation = useSubagentRowPresentation(row, rowServerId);
  const label =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(
    () => openSidebarSubagent({ serverId, workspaceId, parentTabId, row, openInSidePane }),
    [serverId, workspaceId, parentTabId, row, openInSidePane],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const ownWorkspace = useSubagentOwnWorkspace(row, serverId, workspaceId);
  const renderContent = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      const emphasized = active || hovered;
      return (
        <>
          <View style={styles.subagentIconSlot}>
            <WorkspaceTabIcon
              presentation={presentation}
              active={emphasized}
              backdrop={hovered ? "surfaceSidebarHover" : "surfaceSidebar"}
            />
          </View>
          <View style={styles.subagentText}>
            <Text
              numberOfLines={1}
              style={emphasized ? styles.subagentLabelEmphasized : styles.subagentLabel}
            >
              {label}
            </Text>
            {row.kind === "paseo" ? (
              <PaseoSubagentFacts serverId={rowServerId} agentId={row.id} />
            ) : (
              <SubagentFacts text={presentation.subtitle} />
            )}
            {ownWorkspace ? (
              <SubagentWorkspaceMeta serverId={rowServerId} workspace={ownWorkspace} />
            ) : null}
          </View>
        </>
      );
    },
    [active, label, presentation, row.kind, row.id, rowServerId, ownWorkspace],
  );
  return (
    <PressHighlight
      style={subagentRowStyle}
      highlightStyle={styles.rowPressed}
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityState={accessibilityState}
      aria-selected={active}
      accessibilityLabel={label}
      testID={`sidebar-workspace-subagent-${workspaceKey}-${row.id}`}
    >
      {renderContent}
    </PressHighlight>
  );
}

/**
 * The workspace a Paseo subagent runs in when it is not its parent's. Such a child has its own
 * branch, change request, CI and services, which is what its workspace row says at the top level;
 * a child sharing its parent's workspace would only repeat the parent's line.
 */
function useSubagentOwnWorkspace(
  row: SubagentRow,
  parentServerId: string,
  parentWorkspaceId: string,
): WorkspaceDescriptor | null {
  const address = row.kind === "paseo" ? row.address : null;
  return useSessionStore((state) => {
    if (!address) return null;
    const session = state.sessions[address.serverId];
    const agent =
      session?.agents.get(address.agentId) ?? session?.agentDetails.get(address.agentId);
    const workspaceId = agent?.workspaceId;
    if (!workspaceId) return null;
    if (address.serverId === parentServerId && workspaceId === parentWorkspaceId) return null;
    return session?.workspaces.get(workspaceId) ?? null;
  });
}

function normalizeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  return !trimmed || trimmed === "HEAD" ? null : trimmed;
}

/** The meta line the subagent's own workspace row shows: branch, change request, CI, service. */
function SubagentWorkspaceMeta({
  serverId,
  workspace,
}: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}) {
  const prHint = useMemo(
    () => selectPrHintFromStatus(workspace.githubRuntime?.pullRequest, workspace.forge),
    [workspace.githubRuntime?.pullRequest, workspace.forge],
  );
  // Workspace rows leave services to pointer layouts, where the line has room for them.
  const serviceSummary = useMemo(
    () => (isNative ? null : selectWorkspaceServiceSummary(workspace.scripts)),
    [workspace.scripts],
  );
  const labels = useWorkspaceLabelDefinitions(serverId, workspace.labels);
  return (
    <WorkspaceMetaRow
      currentBranch={normalizeBranch(workspace.gitRuntime?.currentBranch)}
      projectName={null}
      hostBadge={null}
      prHint={prHint}
      serviceSummary={serviceSummary}
      labels={labels}
    />
  );
}

/** The model and thinking line the subagents track shows under a Paseo child. */
function PaseoSubagentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  return <SubagentFacts text={useAgentFactsLine(serverId, agentId)} />;
}

function SubagentFacts({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Text numberOfLines={1} style={styles.facts}>
      {text}
    </Text>
  );
}

function subagentRowStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, styles.subagentRow, hovered && styles.rowHovered];
}

const ICON_SIZE = 14;

const styles = StyleSheet.create((theme) => {
  // The workspace row's leading padding, status slot and gap: tab icons start on the rail the
  // workspace title starts on.
  const titleRail = mapLayout(
    densityIconBox("md"),
    (statusSlot) => theme.spacing[2] + statusSlot + theme.spacing[2],
  );
  const statusGroupTitleRail = mapLayout(
    titleRail,
    // `rowIndented` replaces the row's leading padding rather than adding to it: one step more.
    (rail) => rail + theme.spacing[2],
  );
  return {
    list: {
      paddingLeft: titleRail,
      marginBottom: theme.spacing[1],
    },
    listInStatusGroup: {
      paddingLeft: statusGroupTitleRail,
      marginBottom: theme.spacing[1],
    },
    row: {
      minHeight: density.tightRowHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      // The hover fill reaches back past the rail by the row's own padding, so the icon ink
      // stays on the title rail.
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      userSelect: "none",
    },
    // A tab row is a plain View that tracks hover (docs/hover.md) around its press area, the
    // subagent disclosure and the menu. The fill reaches back past the rail by the press area's
    // own padding, so the icon ink stays on the title rail.
    tabRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
    },
    tabRowHovered: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surfaceSidebarHover,
    },
    tabRowPress: {
      flex: 1,
      minWidth: 0,
      minHeight: density.tightRowHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      userSelect: "none",
    },
    menuSlot: {
      paddingRight: theme.spacing[1],
    },
    menuSlotHidden: {
      paddingRight: theme.spacing[1],
      opacity: 0,
    },
    // Children start on the parent tab's label rail: past its icon slot and gap.
    subagentList: {
      paddingLeft: ICON_SIZE + theme.spacing[2],
    },
    // Title over facts over the workspace line, like a workspace row; the icon stays on the
    // title line.
    subagentRow: {
      alignItems: "flex-start",
      paddingVertical: theme.spacing[1],
    },
    subagentIconSlot: {
      width: ICON_SIZE,
      minHeight: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    subagentText: {
      flex: 1,
      minWidth: 0,
    },
    subagentLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    subagentLabelEmphasized: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    facts: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    rowHovered: {
      backgroundColor: theme.colors.surfaceSidebarHover,
    },
    rowPressed: {
      backgroundColor: theme.colors.surface2,
    },
    iconSlot: {
      width: ICON_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    labelEmphasized: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    modifiedDot: {
      width: 8,
      height: 8,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.foregroundMuted,
    },
  };
});
