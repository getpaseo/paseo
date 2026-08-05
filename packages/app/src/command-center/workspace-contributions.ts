import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface WorkspaceCommandCenterLabels {
  section: string;
  newAgent: string;
  newTerminal: string;
  newBrowser: string;
  splitRight: string;
  splitDown: string;
}

export interface WorkspaceCommandCenterIcons {
  newAgent?: CommandCenterIcon;
  newTerminal?: CommandCenterIcon;
  newBrowser?: CommandCenterIcon;
  splitRight?: CommandCenterIcon;
  splitDown?: CommandCenterIcon;
  git?(action: GitAction): CommandCenterIcon | undefined;
}

export interface WorkspaceCommandCenterShortcuts {
  newAgent?: ShortcutKey[][];
  newTerminal?: ShortcutKey[][];
  splitRight?: ShortcutKey[][];
  splitDown?: ShortcutKey[][];
  archiveWorkspace?: ShortcutKey[][];
}

export interface WorkspaceCommandCenterSource {
  gitActions: GitActions;
  labels: WorkspaceCommandCenterLabels;
  icons: WorkspaceCommandCenterIcons;
  shortcuts: WorkspaceCommandCenterShortcuts;
  capabilities: {
    canSplitPanes: boolean;
    canOpenBrowserTabs: boolean;
  };
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

export function buildWorkspaceCommandCenterContributions(
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
      action: { id: "workspace.tab.new", scope: "workspace" },
      visibility: "always",
    }),
  ];
  const primary = source.gitActions.primary;
  if (primary) contributions.push(buildGitContribution(source, primary, 1, "always"));
  contributions.push(
    buildWorkspaceAction({
      source,
      id: "tab:new-terminal",
      rank: 2,
      title: source.labels.newTerminal,
      keywords: ["terminal", "shell", "console"],
      icon: source.icons.newTerminal,
      shortcutKeys: source.shortcuts.newTerminal,
      action: { id: "workspace.terminal.new", scope: "workspace" },
      visibility: "query",
    }),
  );
  if (source.capabilities.canOpenBrowserTabs) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "tab:new-browser",
        rank: 3,
        title: source.labels.newBrowser,
        keywords: ["browser", "web", "preview"],
        icon: source.icons.newBrowser,
        action: { id: "workspace.browser.new", scope: "workspace" },
        visibility: "query",
      }),
    );
  }
  if (source.capabilities.canSplitPanes) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "pane:split-right",
        rank: 4,
        title: source.labels.splitRight,
        keywords: ["split", "pane", "vertical"],
        icon: source.icons.splitRight,
        shortcutKeys: source.shortcuts.splitRight,
        action: { id: "workspace.pane.split.right", scope: "workspace" },
        visibility: "query",
      }),
      buildWorkspaceAction({
        source,
        id: "pane:split-down",
        rank: 5,
        title: source.labels.splitDown,
        keywords: ["split", "pane", "horizontal"],
        icon: source.icons.splitDown,
        shortcutKeys: source.shortcuts.splitDown,
        action: { id: "workspace.pane.split.down", scope: "workspace" },
        visibility: "query",
      }),
    );
  }
  for (const [index, action] of source.gitActions.secondary.entries()) {
    if (action.id === primary?.id) continue;
    contributions.push(buildGitContribution(source, action, 10 + index, "query"));
  }
  return contributions;
}
