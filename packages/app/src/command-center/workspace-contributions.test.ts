import { describe, expect, it } from "vitest";
import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterSource,
} from "./workspace-contributions";

function gitAction(id: GitAction["id"], label: string): GitAction {
  return {
    id,
    label,
    pendingLabel: `${label} pending`,
    successLabel: `${label} complete`,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: () => undefined,
  };
}

function source(gitActions: GitActions): {
  value: WorkspaceCommandCenterSource;
  runGitActions: GitAction[];
  dispatched: KeyboardActionDefinition[];
} {
  const runGitActions: GitAction[] = [];
  const dispatched: KeyboardActionDefinition[] = [];
  return {
    value: {
      gitActions,
      labels: {
        section: "Workspace actions",
        newAgent: "New agent",
        newTerminal: "New terminal",
        newBrowser: "New browser",
        splitRight: "Split pane right",
        splitDown: "Split pane down",
        changes: "Changes",
        files: "Files",
        pullRequest: "Pull request",
        openPanel: (name, placement) => `Open ${name} ${placement}`,
        previousTab: "Previous tab",
        nextTab: "Next tab",
        closeCurrentTab: "Close current tab",
        renameTab: "Rename",
        reloadAgent: "Reload agent",
        copyResumeCommand: "Copy resume command",
        copyAgentId: "Copy agent id",
        copyTerminalId: "Copy terminal id",
        copyFilePath: "Copy file path",
        closeTabsLeft: "Close tabs left",
        closeTabsRight: "Close tabs right",
        closeOtherTabs: "Close other tabs",
        focusPaneLeft: "Focus pane left",
        focusPaneRight: "Focus pane right",
        focusPaneUp: "Focus pane up",
        focusPaneDown: "Focus pane down",
        moveTabLeft: "Move tab left",
        moveTabRight: "Move tab right",
        moveTabUp: "Move tab up",
        moveTabDown: "Move tab down",
        closePane: "Close pane",
        togglePaneMaximization: "Toggle pane maximization",
        toggleFocusMode: "Toggle focus mode",
        toggleSidePanel: "Toggle side panel",
      },
      icons: {},
      shortcuts: {},
      capabilities: { canSplitPanes: true, canOpenBrowserTabs: true, isGit: false },
      activeTabKind: null,
      activeTabIndex: -1,
      activeTabCount: 0,
      dispatch: (action) => dispatched.push(action),
      runGitAction: (action) => runGitActions.push(action),
    },
    runGitActions,
    dispatched,
  };
}

describe("workspace command center contributions", () => {
  it("makes only the policy-selected primary Git action default-visible and runs it", () => {
    const primary = gitAction("commit", "Commit");
    const fixture = source({
      primary,
      secondary: [gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);
    const gitContributions = contributions.filter((item) => item.id.startsWith("git:"));
    const defaultGitContributions = gitContributions.filter((item) => item.visibility === "always");

    expect(defaultGitContributions.map((item) => item.id)).toEqual(["git:commit"]);
    defaultGitContributions[0].run();
    expect(fixture.runGitActions).toEqual([primary]);
  });

  it("does not duplicate a primary action retained in the secondary policy list", () => {
    const primary = gitAction("pull", "Pull");
    const fixture = source({
      primary,
      secondary: [primary, gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.filter((item) => item.id === "git:pull")).toHaveLength(1);
  });

  it("orders New agent before Git and keeps terminal, browser, and splits search-only", () => {
    const fixture = source({
      primary: gitAction("commit", "Commit"),
      secondary: [],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(
      contributions
        .filter((item) =>
          [
            "tab:new-agent",
            "git:commit",
            "tab:new-terminal",
            "tab:new-browser",
            "pane:split-right",
            "pane:split-down",
          ].includes(item.id),
        )
        .map(({ id, visibility }) => ({ id, visibility })),
    ).toEqual([
      { id: "tab:new-agent", visibility: "always" },
      { id: "git:commit", visibility: "always" },
      { id: "tab:new-terminal", visibility: "query" },
      { id: "tab:new-browser", visibility: "query" },
      { id: "pane:split-right", visibility: "query" },
      { id: "pane:split-down", visibility: "query" },
    ]);
  });

  it("omits browser and split actions when their existing capabilities are unavailable", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities = {
      canSplitPanes: false,
      canOpenBrowserTabs: false,
      isGit: false,
    };

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.some((item) => item.id === "tab:new-agent")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-terminal")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-browser")).toBe(false);
    expect(contributions.some((item) => item.id.startsWith("pane:"))).toBe(false);
  });

  it("dispatches every tab and pane command to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    for (const contribution of contributions) contribution.run();

    expect(fixture.dispatched.length).toBeGreaterThan(5);
    expect(fixture.dispatched.every((action) => action.scope === "workspace")).toBe(true);
  });

  it("keeps workspace creation commands available outside Git", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.some((item) => item.id === "tab:new-agent")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-terminal")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-browser")).toBe(true);
    expect(contributions.some((item) => item.id === "pane:split-right")).toBe(true);
    expect(contributions.some((item) => item.id === "pane:split-down")).toBe(true);
    expect(contributions.some((item) => item.id.startsWith("git:"))).toBe(false);
  });
});
