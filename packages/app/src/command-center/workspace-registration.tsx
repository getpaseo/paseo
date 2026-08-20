import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Columns2, Globe, Rows2, SquarePen, SquareTerminal } from "lucide-react-native";
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
};

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
  };
}

export function useWorkspaceCommandCenterActions(): void {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const { t } = useTranslation();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  const { overrides } = useKeyboardShortcutOverrides();
  const { gitActions } = useGitActions({
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
        },
        icons: {
          ...WORKSPACE_COMMAND_CENTER_ICONS,
          git: (action) => staticIcon(action.icon),
        },
        shortcuts: resolveWorkspaceShortcuts(overrides),
        capabilities: {
          canSplitPanes: supportsDesktopPaneSplits() && !isCompact,
          canOpenBrowserTabs: getIsElectron(),
        },
        dispatch: (action) => {
          clearCommandCenterFocusRestoreElement();
          keyboardActionDispatcher.dispatch(action);
        },
        runGitAction,
      }),
    [gitActions, isCompact, keyboardActionDispatcher, overrides, runGitAction, t],
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
