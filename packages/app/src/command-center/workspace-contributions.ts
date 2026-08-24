import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type {
  WorkspacePanelPlacement,
  WorkspacePanelTarget,
} from "@/keyboard/keyboard-action-dispatcher";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface WorkspaceCommandCenterLabels {
  section: string;
  newAgent: string;
  newTerminal: string;
  newBrowser: string;
  splitRight: string;
  splitDown: string;
  changes: string;
  files: string;
  pullRequest: string;
  openPanel(name: string, placement: WorkspacePanelPlacement): string;
  previousTab: string;
  nextTab: string;
  closeCurrentTab: string;
  renameTab: string;
  reloadAgent: string;
  copyResumeCommand: string;
  copyAgentId: string;
  copyTerminalId: string;
  copyFilePath: string;
  closeTabsLeft: string;
  closeTabsRight: string;
  closeOtherTabs: string;
  focusPaneLeft: string;
  focusPaneRight: string;
  focusPaneUp: string;
  focusPaneDown: string;
  moveTabLeft: string;
  moveTabRight: string;
  moveTabUp: string;
  moveTabDown: string;
  closePane: string;
  togglePaneMaximization: string;
  toggleFocusMode: string;
  toggleSidePanel: string;
}

export interface WorkspaceCommandCenterIcons {
  newAgent?: CommandCenterIcon;
  newTerminal?: CommandCenterIcon;
  newBrowser?: CommandCenterIcon;
  splitRight?: CommandCenterIcon;
  splitDown?: CommandCenterIcon;
  changes?: CommandCenterIcon;
  files?: CommandCenterIcon;
  pullRequest?: CommandCenterIcon;
  previousTab?: CommandCenterIcon;
  nextTab?: CommandCenterIcon;
  close?: CommandCenterIcon;
  rename?: CommandCenterIcon;
  reload?: CommandCenterIcon;
  copy?: CommandCenterIcon;
  focusPane?: CommandCenterIcon;
  moveTab?: CommandCenterIcon;
  maximize?: CommandCenterIcon;
  focusMode?: CommandCenterIcon;
  sidePanel?: CommandCenterIcon;
  git?(action: GitAction): CommandCenterIcon | undefined;
}

export interface WorkspaceCommandCenterShortcuts {
  newAgent?: ShortcutKey[][];
  newTerminal?: ShortcutKey[][];
  splitRight?: ShortcutKey[][];
  splitDown?: ShortcutKey[][];
  archiveWorkspace?: ShortcutKey[][];
  previousTab?: ShortcutKey[][];
  nextTab?: ShortcutKey[][];
  closeCurrentTab?: ShortcutKey[][];
  closePane?: ShortcutKey[][];
  togglePaneMaximization?: ShortcutKey[][];
  toggleFocusMode?: ShortcutKey[][];
  toggleSidePanel?: ShortcutKey[][];
}

export interface WorkspaceCommandCenterSource {
  gitActions: GitActions;
  labels: WorkspaceCommandCenterLabels;
  icons: WorkspaceCommandCenterIcons;
  shortcuts: WorkspaceCommandCenterShortcuts;
  capabilities: {
    canSplitPanes: boolean;
    canOpenBrowserTabs: boolean;
    isGit: boolean;
  };
  activeTabKind: WorkspaceTabTarget["kind"] | null;
  activeTabIndex: number;
  activeTabCount: number;
  dispatch(action: KeyboardActionDefinition): void;
  runGitAction(action: GitAction): void;
}

function buildGitContribution(
  source: WorkspaceCommandCenterSource,
  action: GitAction,
  rank: number,
  visibility: "always" | "query",
): CommandCenterContribution {
  return {
    id: `git:${action.id}`,
    group: "workspace",
    groupRank: -1,
    rank,
    keywords: [action.id, "git"],
    visibility,
    run: () => source.runGitAction(action),
    presentation: {
      kind: "action",
      title: action.label,
      sectionTitle: source.labels.section,
      icon: source.icons.git?.(action),
      shortcutKeys:
        action.id === "archive-workspace" ? source.shortcuts.archiveWorkspace : undefined,
    },
  };
}

function buildWorkspaceAction(input: {
  source: WorkspaceCommandCenterSource;
  id: string;
  rank: number;
  title: string;
  keywords: readonly string[];
  icon?: CommandCenterIcon;
  shortcutKeys?: ShortcutKey[][];
  action: KeyboardActionDefinition;
  visibility: "always" | "query";
}): CommandCenterContribution {
  return {
    id: input.id,
    group: "workspace",
    groupRank: -1,
    rank: input.rank,
    keywords: input.keywords,
    visibility: input.visibility,
    run: () => input.source.dispatch(input.action),
    presentation: {
      kind: "action",
      title: input.title,
      sectionTitle: input.source.labels.section,
      icon: input.icon,
      shortcutKeys: input.shortcutKeys,
    },
  };
}

type QueryActionInput = Omit<Parameters<typeof buildWorkspaceAction>[0], "source" | "visibility">;

function buildQueryAction(
  source: WorkspaceCommandCenterSource,
  input: QueryActionInput,
): CommandCenterContribution {
  return buildWorkspaceAction({ ...input, source, visibility: "query" });
}

function buildPanelContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  const panelTargets: Array<{
    target: WorkspacePanelTarget;
    name: string;
    icon?: CommandCenterIcon;
  }> = [
    { target: "changes", name: source.labels.changes, icon: source.icons.changes },
    { target: "files", name: source.labels.files, icon: source.icons.files },
    {
      target: "pull-request",
      name: source.labels.pullRequest,
      icon: source.icons.pullRequest,
    },
  ];
  for (const [index, panel] of panelTargets.entries()) {
    if (panel.target !== "files" && !source.capabilities.isGit) continue;
    contributions.push(
      buildQueryAction(source, {
        id: `tab:open:${panel.target}`,
        rank: 4 + index,
        title: source.labels.openPanel(panel.name, "supporting"),
        keywords: ["open", panel.target, "tab", "supporting"],
        icon: panel.icon,
        action: {
          id: "workspace.tab.open",
          scope: "workspace",
          target: panel.target,
          placement: "supporting",
        },
      }),
    );
    if (!source.capabilities.canSplitPanes) continue;
    for (const [placementIndex, placement] of (["side-panel", "focused-pane"] as const).entries()) {
      contributions.push(
        buildQueryAction(source, {
          id: `tab:open:${panel.target}:${placement}`,
          rank: 10 + index * 2 + placementIndex,
          title: source.labels.openPanel(panel.name, placement),
          keywords: ["open", panel.target, "tab", placement, "pane"],
          icon: panel.icon,
          action: {
            id: "workspace.tab.open",
            scope: "workspace",
            target: panel.target,
            placement,
          },
        }),
      );
    }
  }
  return contributions;
}

function buildActiveTabContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  if (source.activeTabCount === 0) return [];
  const contributions: CommandCenterContribution[] = [
    buildQueryAction(source, {
      id: "tab:previous",
      rank: 30,
      title: source.labels.previousTab,
      keywords: ["tab", "previous", "switch", "navigate"],
      icon: source.icons.previousTab,
      shortcutKeys: source.shortcuts.previousTab,
      action: { id: "workspace.tab.navigate-relative", scope: "workspace", delta: -1 },
    }),
    buildQueryAction(source, {
      id: "tab:next",
      rank: 31,
      title: source.labels.nextTab,
      keywords: ["tab", "next", "switch", "navigate"],
      icon: source.icons.nextTab,
      shortcutKeys: source.shortcuts.nextTab,
      action: { id: "workspace.tab.navigate-relative", scope: "workspace", delta: 1 },
    }),
    buildQueryAction(source, {
      id: "tab:close-current",
      rank: 32,
      title: source.labels.closeCurrentTab,
      keywords: ["tab", "close", "current"],
      icon: source.icons.close,
      shortcutKeys: source.shortcuts.closeCurrentTab,
      action: { id: "workspace.tab.close-current", scope: "workspace" },
    }),
  ];
  if (source.activeTabKind === "agent" || source.activeTabKind === "terminal") {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:rename-current",
        rank: 33,
        title: source.labels.renameTab,
        keywords: ["tab", "rename", "current"],
        icon: source.icons.rename,
        action: { id: "workspace.tab.rename-current", scope: "workspace" },
      }),
      buildQueryAction(source, {
        id: "tab:copy-id",
        rank: 34,
        title:
          source.activeTabKind === "agent"
            ? source.labels.copyAgentId
            : source.labels.copyTerminalId,
        keywords: ["tab", "copy", "id"],
        icon: source.icons.copy,
        action: { id: "workspace.tab.copy-id", scope: "workspace" },
      }),
    );
  }
  if (source.activeTabKind === "agent") {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:reload-current",
        rank: 35,
        title: source.labels.reloadAgent,
        keywords: ["tab", "agent", "reload"],
        icon: source.icons.reload,
        action: { id: "workspace.tab.reload-current", scope: "workspace" },
      }),
      buildQueryAction(source, {
        id: "tab:copy-resume-command",
        rank: 36,
        title: source.labels.copyResumeCommand,
        keywords: ["tab", "agent", "copy", "resume", "command"],
        icon: source.icons.copy,
        action: { id: "workspace.tab.copy-resume-command", scope: "workspace" },
      }),
    );
  }
  if (source.activeTabKind === "file") {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:copy-file-path",
        rank: 37,
        title: source.labels.copyFilePath,
        keywords: ["tab", "file", "copy", "path"],
        icon: source.icons.copy,
        action: { id: "workspace.tab.copy-file-path", scope: "workspace" },
      }),
    );
  }
  if (source.activeTabIndex > 0) {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:close-left",
        rank: 38,
        title: source.labels.closeTabsLeft,
        keywords: ["tab", "close", "left"],
        icon: source.icons.close,
        action: { id: "workspace.tab.close-left", scope: "workspace" },
      }),
    );
  }
  if (source.activeTabIndex >= 0 && source.activeTabIndex < source.activeTabCount - 1) {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:close-right",
        rank: 39,
        title: source.labels.closeTabsRight,
        keywords: ["tab", "close", "right"],
        icon: source.icons.close,
        action: { id: "workspace.tab.close-right", scope: "workspace" },
      }),
    );
  }
  if (source.activeTabCount > 1) {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:close-others",
        rank: 40,
        title: source.labels.closeOtherTabs,
        keywords: ["tab", "close", "others"],
        icon: source.icons.close,
        action: { id: "workspace.tab.close-others", scope: "workspace" },
      }),
    );
  }
  return contributions;
}

function buildPaneContributions(source: WorkspaceCommandCenterSource): CommandCenterContribution[] {
  const paneActions: Array<{
    id: string;
    rank: number;
    title: string;
    keywords: string[];
    action: KeyboardActionDefinition;
    icon?: CommandCenterIcon;
    shortcutKeys?: ShortcutKey[][];
  }> = [
    {
      id: "pane:split-right",
      rank: 50,
      title: source.labels.splitRight,
      keywords: ["split", "pane", "vertical"],
      icon: source.icons.splitRight,
      shortcutKeys: source.shortcuts.splitRight,
      action: { id: "workspace.pane.split.right", scope: "workspace" },
    },
    {
      id: "pane:split-down",
      rank: 51,
      title: source.labels.splitDown,
      keywords: ["split", "pane", "horizontal"],
      icon: source.icons.splitDown,
      shortcutKeys: source.shortcuts.splitDown,
      action: { id: "workspace.pane.split.down", scope: "workspace" },
    },
    {
      id: "pane:focus-left",
      rank: 52,
      title: source.labels.focusPaneLeft,
      keywords: ["pane", "focus", "left"],
      icon: source.icons.focusPane,
      action: { id: "workspace.pane.focus.left", scope: "workspace" },
    },
    {
      id: "pane:focus-right",
      rank: 53,
      title: source.labels.focusPaneRight,
      keywords: ["pane", "focus", "right"],
      icon: source.icons.focusPane,
      action: { id: "workspace.pane.focus.right", scope: "workspace" },
    },
    {
      id: "pane:focus-up",
      rank: 54,
      title: source.labels.focusPaneUp,
      keywords: ["pane", "focus", "up"],
      icon: source.icons.focusPane,
      action: { id: "workspace.pane.focus.up", scope: "workspace" },
    },
    {
      id: "pane:focus-down",
      rank: 55,
      title: source.labels.focusPaneDown,
      keywords: ["pane", "focus", "down"],
      icon: source.icons.focusPane,
      action: { id: "workspace.pane.focus.down", scope: "workspace" },
    },
    {
      id: "pane:move-tab-left",
      rank: 56,
      title: source.labels.moveTabLeft,
      keywords: ["pane", "tab", "move", "left"],
      icon: source.icons.moveTab,
      action: { id: "workspace.pane.move-tab.left", scope: "workspace" },
    },
    {
      id: "pane:move-tab-right",
      rank: 57,
      title: source.labels.moveTabRight,
      keywords: ["pane", "tab", "move", "right"],
      icon: source.icons.moveTab,
      action: { id: "workspace.pane.move-tab.right", scope: "workspace" },
    },
    {
      id: "pane:move-tab-up",
      rank: 58,
      title: source.labels.moveTabUp,
      keywords: ["pane", "tab", "move", "up"],
      icon: source.icons.moveTab,
      action: { id: "workspace.pane.move-tab.up", scope: "workspace" },
    },
    {
      id: "pane:move-tab-down",
      rank: 59,
      title: source.labels.moveTabDown,
      keywords: ["pane", "tab", "move", "down"],
      icon: source.icons.moveTab,
      action: { id: "workspace.pane.move-tab.down", scope: "workspace" },
    },
    {
      id: "pane:close",
      rank: 60,
      title: source.labels.closePane,
      keywords: ["pane", "close"],
      icon: source.icons.close,
      shortcutKeys: source.shortcuts.closePane,
      action: { id: "workspace.pane.close", scope: "workspace" },
    },
    {
      id: "pane:maximize-toggle",
      rank: 61,
      title: source.labels.togglePaneMaximization,
      keywords: ["pane", "maximize", "restore", "toggle"],
      icon: source.icons.maximize,
      shortcutKeys: source.shortcuts.togglePaneMaximization,
      action: { id: "workspace.explorer.maximize.toggle", scope: "workspace" },
    },
    {
      id: "pane:focus-mode-toggle",
      rank: 62,
      title: source.labels.toggleFocusMode,
      keywords: ["pane", "focus", "mode", "toggle"],
      icon: source.icons.focusMode,
      shortcutKeys: source.shortcuts.toggleFocusMode,
      action: { id: "workspace.focus.toggle", scope: "workspace" },
    },
  ];
  return paneActions.map((action) => buildQueryAction(source, action));
}

function buildCreationContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [
    buildWorkspaceAction({
      source,
      id: "tab:new-agent",
      rank: 0,
      title: source.labels.newAgent,
      keywords: ["tab", "new", "agent", "chat"],
      icon: source.icons.newAgent,
      shortcutKeys: source.shortcuts.newAgent,
      action: { id: "workspace.agent.new", scope: "workspace" },
      visibility: "always",
    }),
  ];
  const primary = source.gitActions.primary;
  if (primary) contributions.push(buildGitContribution(source, primary, 1, "always"));
  contributions.push(
    buildQueryAction(source, {
      id: "tab:new-terminal",
      rank: 2,
      title: source.labels.newTerminal,
      keywords: ["terminal", "shell", "console"],
      icon: source.icons.newTerminal,
      shortcutKeys: source.shortcuts.newTerminal,
      action: { id: "workspace.terminal.new", scope: "workspace" },
    }),
  );
  if (source.capabilities.canOpenBrowserTabs) {
    contributions.push(
      buildQueryAction(source, {
        id: "tab:new-browser",
        rank: 3,
        title: source.labels.newBrowser,
        keywords: ["browser", "web", "preview"],
        icon: source.icons.newBrowser,
        action: { id: "workspace.browser.new", scope: "workspace" },
      }),
    );
  }
  return contributions;
}

export function buildWorkspaceCommandCenterContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  const contributions = [
    ...buildCreationContributions(source),
    ...buildPanelContributions(source),
    ...buildActiveTabContributions(source),
    ...(source.capabilities.canSplitPanes ? buildPaneContributions(source) : []),
    buildQueryAction(source, {
      id: "side-panel:toggle",
      rank: 70,
      title: source.labels.toggleSidePanel,
      keywords: ["side", "panel", "toggle", "show", "hide"],
      icon: source.icons.sidePanel,
      shortcutKeys: source.shortcuts.toggleSidePanel,
      action: { id: "sidebar.toggle.right", scope: "workspace" },
    }),
  ];
  const primary = source.gitActions.primary;
  for (const [index, action] of source.gitActions.secondary.entries()) {
    if (action.id === primary?.id) continue;
    contributions.push(buildGitContribution(source, action, 100 + index, "query"));
  }
  return contributions;
}
