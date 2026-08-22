import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Columns2,
  Copy,
  Files,
  Focus,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  Maximize2,
  Move,
  PanelRight,
  Pencil,
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
import {
  resolveShortcutKeysForAction,
  type ShortcutOverrides,
} from "@/keyboard/keyboard-shortcuts";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getCommandCenterIcon } from "./icon";
import type { CommandCenterIcon } from "./contributions";
import { useCommandCenterActions } from "./provider";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterShortcuts,
} from "./workspace-contributions";

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
  maximize: getCommandCenterIcon(Maximize2),
  focusMode: getCommandCenterIcon(ArrowDownToLine),
  sidePanel: getCommandCenterIcon(PanelRight),
};

const OPEN_PANEL_LABEL_KEYS = {
  supporting: "shell.commandCenter.open",
  "side-panel": "shell.commandCenter.openInSidePanel",
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
  return {
    newAgent: resolveShortcutKeysForAction("workspace-tab-new", overrides, platform) ?? undefined,
    newTerminal:
      resolveShortcutKeysForAction("workspace-terminal-new", overrides, platform) ?? undefined,
    splitRight:
      resolveShortcutKeysForAction("workspace-pane-split-right", overrides, platform) ?? undefined,
    splitDown:
      resolveShortcutKeysForAction("workspace-pane-split-down", overrides, platform) ?? undefined,
    archiveWorkspace:
      resolveShortcutKeysForAction("archive-workspace", overrides, platform) ?? undefined,
    previousTab:
      resolveShortcutKeysForAction("workspace-tab-prev", overrides, platform) ?? undefined,
    nextTab: resolveShortcutKeysForAction("workspace-tab-next", overrides, platform) ?? undefined,
    closeCurrentTab:
      resolveShortcutKeysForAction("workspace-tab-close-current", overrides, platform) ?? undefined,
    closePane:
      resolveShortcutKeysForAction("workspace-pane-close", overrides, platform) ?? undefined,
    togglePaneMaximization:
      resolveShortcutKeysForAction("workspace-explorer-maximize", overrides, platform) ?? undefined,
    toggleSidePanel:
      resolveShortcutKeysForAction("toggle-right-sidebar", overrides, platform) ?? undefined,
  };
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
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  const { overrides } = useKeyboardShortcutOverrides();
  const { gitActions, isGit } = useGitActions({
    serverId: serverId ?? "",
    cwd: cwd ?? "",
    icons: GIT_ACTION_ICONS,
  });
  const runGitAction = useGitActionRunner();

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
          togglePaneMaximization: t("settings.shortcuts.help.toggleExplorerPaneMaximization"),
          toggleFocusMode: t("settings.shortcuts.help.toggleFocusMode"),
          toggleSidePanel: t("workspace.tabs.sidePanel.toggle"),
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
        },
        activeTabKind,
        activeTabIndex,
        activeTabCount: focusedTabs.length,
        dispatch: (action) => {
          clearCommandCenterFocusRestoreElement();
          keyboardActionDispatcher.dispatch(action);
        },
        runGitAction,
      }),
    [
      activeTabIndex,
      activeTabKind,
      focusedTabs.length,
      gitActions,
      isCompact,
      isGit,
      keyboardActionDispatcher,
      overrides,
      runGitAction,
      t,
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
