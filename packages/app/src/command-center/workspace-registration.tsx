import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Columns2,
  Copy,
  Files,
  Focus,
  GitBranch,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  ListChecks,
  Move,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  Rows2,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { getIsElectron } from "@/constants/platform";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActionRunner, useGitActions } from "@/git/use-actions";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useWorkspaceClipboardActions } from "@/hooks/use-workspace-clipboard-actions";
import { useToast } from "@/contexts/toast-context";
import { type ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { shouldShowWorkspaceSetup, useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getShortcutOs } from "@/utils/shortcut-platform";
import {
  buildWorkspaceLabelPickerRows,
  useWorkspaceLabelProjection,
  workspaceLabelErrorMessage,
  workspaceLabels,
} from "@/workspace-labels";
import { getLabelCommandCenterIcon } from "@/workspace-labels/command-center-icon";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getCommandCenterIcon } from "./icon";
import type { CommandCenterIcon } from "./contributions";
import { useCommandCenterActions } from "./provider";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterLabelChoice,
  type WorkspaceCommandCenterShortcuts,
} from "./workspace-contributions";
import { resolveWorkspaceCommandCenterShortcuts } from "./workspace-shortcuts";

const WORKSPACE_COMMAND_CENTER_ICONS = {
  newAgent: getCommandCenterIcon(SquarePen),
  newTerminal: getCommandCenterIcon(SquareTerminal),
  newBrowser: getCommandCenterIcon(Globe),
  splitRight: getCommandCenterIcon(Columns2),
  splitDown: getCommandCenterIcon(Rows2),
  changes: getCommandCenterIcon(GitCompareArrows),
  files: getCommandCenterIcon(Files),
  pullRequest: getCommandCenterIcon(GitPullRequest),
  previousTab: getCommandCenterIcon(ArrowLeft),
  nextTab: getCommandCenterIcon(ArrowRight),
  close: getCommandCenterIcon(X),
  rename: getCommandCenterIcon(Pencil),
  reload: getCommandCenterIcon(RotateCw),
  copy: getCommandCenterIcon(Copy),
  focusPane: getCommandCenterIcon(Focus),
  moveTab: getCommandCenterIcon(Move),
  focusMode: getCommandCenterIcon(ArrowDownToLine),
  explorerSidebar: getCommandCenterIcon(PanelRight),
  // Workspace management action icons
  copyPath: getCommandCenterIcon(Copy),
  copyBranchName: getCommandCenterIcon(GitBranch),
  pin: getCommandCenterIcon(Pin),
  unpin: getCommandCenterIcon(PinOff),
  showSetup: getCommandCenterIcon(ListChecks),
  toggleFocusMode: getCommandCenterIcon(Focus),
};

const OPEN_PANEL_LABEL_KEYS = {
  supporting: "shell.commandCenter.open",
  "side-pane": "shell.commandCenter.openInSidePane",
  "focused-pane": "shell.commandCenter.openInFocusedPane",
} as const;

function staticIcon(element: ReactElement | undefined): CommandCenterIcon | undefined {
  if (!element) return undefined;
  function StaticIcon() {
    return element;
  }
  return StaticIcon;
}

function resolveWorkspaceShortcuts(overrides: ShortcutOverrides): WorkspaceCommandCenterShortcuts {
  const platform = { isMac: getShortcutOs() === "mac", isDesktop: getIsElectron() };
  return resolveWorkspaceCommandCenterShortcuts({ overrides, platform });
}

/**
 * The label catalog and its toggle callback, pulled out of `useWorkspaceCommandCenterActions` to
 * keep that hook under the complexity limit. Null while the host's catalog hasn't loaded, so the
 * group is omitted rather than shown empty — the same rule `WorkspaceLabelPickerPage` follows for
 * the sidebar's own picker.
 */
function useWorkspaceLabelCatalog(
  serverId: string | null,
  fields: { id: string; labels: readonly string[] } | null,
): {
  labelCatalog: readonly WorkspaceCommandCenterLabelChoice[] | null;
  toggleLabel: (name: string, assigned: boolean) => void;
} {
  const { labels: labelDefinitions, targetHost: labelHost } = useWorkspaceLabelProjection(
    serverId ?? undefined,
  );
  const toast = useToast();
  const assignedLabels = fields?.labels;
  const labelCatalog = useMemo<readonly WorkspaceCommandCenterLabelChoice[] | null>(
    () =>
      labelHost?.status === "online" && assignedLabels
        ? buildWorkspaceLabelPickerRows({ labels: labelDefinitions, assigned: assignedLabels }).map(
            (row) => ({
              name: row.name,
              assigned: row.assigned,
              icon: getLabelCommandCenterIcon(row.color),
            }),
          )
        : null,
    [assignedLabels, labelDefinitions, labelHost?.status],
  );
  const toggleLabel = useCallback(
    async (name: string, assigned: boolean) => {
      if (!serverId || !fields) return;
      const definition = labelDefinitions.find((label) => label.name === name);
      if (!definition) return;
      try {
        await workspaceLabels.setAssignment({
          serverId,
          workspaceId: fields.id,
          label: definition,
          assigned,
        });
      } catch (cause) {
        toast.error(workspaceLabelErrorMessage(cause));
      }
    },
    [fields, labelDefinitions, serverId, toast],
  );
  return { labelCatalog, toggleLabel };
}

export function useWorkspaceCommandCenterActions(): void {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const { t } = useTranslation();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceKey =
    serverId && workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );
  const focusedPane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  const focusedTabs = layout
    ? collectAllTabs(layout.root).filter((tab) => focusedPane?.tabIds.includes(tab.tabId))
    : [];
  const activeTabIndex = focusedTabs.findIndex((tab) => tab.tabId === focusedPane?.focusedTabId);
  const activeTabKind =
    activeTabIndex >= 0 ? (focusedTabs[activeTabIndex]?.target.kind ?? null) : null;
  // One narrow projection for the workspace management contribution fields. The registry's snapshot
  // dedup is unreachable (registry.ts spreads a fresh object per contribution, then compares by
  // reference), so the array-identity guard in registry.replace() is the only thing stopping a
  // re-render — a churny subscription here rebuilds the list while the user is looking at it.
  const fields = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    id: workspace.id,
    workspaceDirectory: workspace.workspaceDirectory ?? null,
    currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    pinnedAt: workspace.pinnedAt ?? null,
    labels: workspace.labels ?? [],
  }));
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const currentBranch = fields?.currentBranch ?? null;
  const isPinned = fields?.pinnedAt != null;
  const isCompact = useIsCompactFormFactor();
  const canPin = useHostFeature(serverId, "workspacePinning");
  const persistenceKey =
    serverId && fields
      ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: fields.id })
      : null;
  const canShowSetup = useWorkspaceSetupStore((state) =>
    shouldShowWorkspaceSetup(persistenceKey ? (state.snapshots[persistenceKey] ?? null) : null),
  );
  const { overrides } = useKeyboardShortcutOverrides();
  const { gitActions, isGit } = useGitActions({
    serverId: serverId ?? "",
    cwd: cwd ?? "",
    icons: GIT_ACTION_ICONS,
  });
  const runGitAction = useGitActionRunner();
  const clipboard = useWorkspaceClipboardActions();

  const copyPath = useCallback(() => {
    if (!fields) return;
    clipboard.copyPath({
      workspaceId: fields.id,
      workspaceDirectory: fields.workspaceDirectory,
      currentBranch: fields.currentBranch,
    });
  }, [clipboard, fields]);

  const copyBranchName = useCallback(() => {
    if (!fields) return;
    clipboard.copyBranchName({
      workspaceId: fields.id,
      workspaceDirectory: fields.workspaceDirectory,
      currentBranch: fields.currentBranch,
    });
  }, [clipboard, fields]);

  const { labelCatalog, toggleLabel } = useWorkspaceLabelCatalog(serverId, fields);

  const actions = useMemo(
    () =>
      buildWorkspaceCommandCenterContributions({
        gitActions,
        labels: {
          section: t("workspace.header.actions.workspaceActions"),
          newAgent: t("workspace.tabs.actions.newAgent"),
          newTerminal: t("workspace.tabs.actions.newTerminal"),
          newBrowser: t("workspace.tabs.actions.newBrowser"),
          splitRight: t("workspace.tabs.actions.splitRight"),
          splitDown: t("workspace.tabs.actions.splitDown"),
          changes: t("workspace.tabs.actions.changes"),
          files: t("workspace.tabs.actions.files"),
          pullRequest: t("workspace.tabs.actions.pullRequest"),
          openPanel: (name, placement) => t(OPEN_PANEL_LABEL_KEYS[placement], { name }),
          previousTab: t("settings.shortcuts.help.previousTab"),
          nextTab: t("settings.shortcuts.help.nextTab"),
          closeCurrentTab: t("settings.shortcuts.help.closeCurrentTab"),
          renameTab: t("workspace.tabs.menu.rename"),
          reloadAgent: t("workspace.tabs.menu.reloadAgent"),
          copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
          copyAgentId: t("workspace.tabs.menu.copyAgentId"),
          copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
          copyFilePath: t("workspace.tabs.menu.copyFilePath"),
          closeTabsLeft: t("workspace.tabs.menu.closeLeft"),
          closeTabsRight: t("workspace.tabs.menu.closeRight"),
          closeOtherTabs: t("workspace.tabs.menu.closeOthers"),
          focusPaneLeft: t("settings.shortcuts.help.focusPaneLeft"),
          focusPaneRight: t("settings.shortcuts.help.focusPaneRight"),
          focusPaneUp: t("settings.shortcuts.help.focusPaneUp"),
          focusPaneDown: t("settings.shortcuts.help.focusPaneDown"),
          moveTabLeft: t("settings.shortcuts.help.moveTabLeft"),
          moveTabRight: t("settings.shortcuts.help.moveTabRight"),
          moveTabUp: t("settings.shortcuts.help.moveTabUp"),
          moveTabDown: t("settings.shortcuts.help.moveTabDown"),
          closePane: t("settings.shortcuts.help.closePane"),
          toggleFocusMode: t("settings.shortcuts.help.toggleFocusMode"),
          toggleExplorerSidebar: t("workspace.tabs.explorerSidebar.toggle"),
          // Workspace management labels
          rename: t("sidebar.workspace.actions.rename"),
          copyPath: t("workspace.header.actions.copyPath"),
          copyBranchName: t("workspace.header.actions.copyBranchName"),
          pin: t("sidebar.workspace.actions.pin"),
          unpin: t("sidebar.workspace.actions.unpin"),
          showSetup: t("workspace.header.actions.showSetup"),
          labelsGroup: t("workspaceLabels.title"),
        },
        icons: {
          ...WORKSPACE_COMMAND_CENTER_ICONS,
          git: (action) => staticIcon(action.icon),
        },
        shortcuts: resolveWorkspaceShortcuts(overrides),
        capabilities: {
          canSplitPanes: supportsDesktopPaneSplits() && !isCompact,
          canOpenBrowserTabs: getIsElectron(),
          isGit,
          canPin,
          canShowSetup,
        },
        activeTabKind,
        activeTabIndex,
        activeTabCount: focusedTabs.length,
        currentBranch,
        isPinned,
        labelCatalog,
        dispatch: (action) => {
          clearCommandCenterFocusRestoreElement();
          keyboardActionDispatcher.dispatch(action);
        },
        runGitAction,
        copyPath,
        copyBranchName,
        toggleLabel,
      }),
    [
      activeTabIndex,
      activeTabKind,
      canPin,
      canShowSetup,
      copyBranchName,
      copyPath,
      currentBranch,
      focusedTabs.length,
      gitActions,
      isCompact,
      isGit,
      isPinned,
      keyboardActionDispatcher,
      labelCatalog,
      overrides,
      runGitAction,
      t,
      toggleLabel,
    ],
  );

  useCommandCenterActions({
    sourceId: "workspace",
    enabled: Boolean(serverId && cwd),
    actions,
  });
}

export function CommandCenterWorkspaceActions() {
  useWorkspaceCommandCenterActions();
  return null;
}
