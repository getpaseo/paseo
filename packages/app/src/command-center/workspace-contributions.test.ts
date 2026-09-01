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
  copiedPaths: number;
  copiedBranchNames: number;
  toggledLabels: Array<{ name: string; assigned: boolean }>;
} {
  const runGitActions: GitAction[] = [];
  const dispatched: KeyboardActionDefinition[] = [];
  const toggledLabels: Array<{ name: string; assigned: boolean }> = [];
  const counters = { copiedPaths: 0, copiedBranchNames: 0 };
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
        toggleFocusMode: "Toggle focus mode",
        toggleExplorerSidebar: "Toggle Explorer sidebar",
        rename: "Rename workspace",
        copyPath: "Copy workspace path",
        copyBranchName: "Copy branch name",
        pin: "Pin to top",
        unpin: "Unpin",
        showSetup: "Show setup",
        labelsGroup: "Labels",
      },
      icons: {},
      shortcuts: {},
      capabilities: {
        canSplitPanes: true,
        canOpenBrowserTabs: true,
        isGit: false,
        canPin: false,
        canShowSetup: false,
      },
      activeTabKind: null,
      activeTabIndex: -1,
      activeTabCount: 0,
      currentBranch: null,
      isPinned: false,
      labelCatalog: null,
      dispatch: (action) => dispatched.push(action),
      runGitAction: (action) => runGitActions.push(action),
      copyPath: () => {
        counters.copiedPaths += 1;
      },
      copyBranchName: () => {
        counters.copiedBranchNames += 1;
      },
      toggleLabel: (name, assigned) => {
        toggledLabels.push({ name, assigned });
      },
    },
    runGitActions,
    dispatched,
    toggledLabels,
    get copiedPaths() {
      return counters.copiedPaths;
    },
    get copiedBranchNames() {
      return counters.copiedBranchNames;
    },
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
      canPin: false,
      canShowSetup: false,
    };

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.some((item) => item.id === "tab:new-agent")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-terminal")).toBe(true);
    expect(contributions.some((item) => item.id === "tab:new-browser")).toBe(false);
    expect(contributions.some((item) => item.id.startsWith("pane:"))).toBe(false);
    expect(contributions.some((item) => item.id === "workspace:rename")).toBe(true);
    expect(contributions.some((item) => item.id === "workspace:copy-path")).toBe(true);
  });

  it("dispatches every tab and pane command to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    for (const contribution of contributions) contribution.run();

    expect(fixture.dispatched.length).toBeGreaterThan(5);
    // workspace:rename dispatches to workspace scope
    expect(
      fixture.dispatched.some((a) => a.id === "workspace.rename" && a.scope === "workspace"),
    ).toBe(true);
    // workspace:toggle-explorer-sidebar intentionally dispatches to sidebar scope
    expect(
      fixture.dispatched.some((a) => a.id === "sidebar.toggle.right" && a.scope === "sidebar"),
    ).toBe(true);
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

  it("dispatches rename to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    const rename = contributions.find((item) => item.id === "workspace:rename");
    expect(rename?.presentation).toMatchObject({ title: "Rename workspace" });
    rename?.run();

    expect(fixture.dispatched).toEqual([{ id: "workspace.rename", scope: "workspace" }]);
  });

  it("copies the workspace path without going through the dispatcher", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    contributions.find((item) => item.id === "workspace:copy-path")?.run();

    expect(fixture.copiedPaths).toBe(1);
    expect(fixture.dispatched).toEqual([]);
  });

  it("omits Copy branch name when the workspace has no branch, and copies when it does", () => {
    const withoutBranch = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(withoutBranch.value).some(
        (item) => item.id === "workspace:copy-branch-name",
      ),
    ).toBe(false);

    const withBranch = source({ primary: null, secondary: [], menu: [] });
    withBranch.value.currentBranch = "feature/login";
    const contribution = buildWorkspaceCommandCenterContributions(withBranch.value).find(
      (item) => item.id === "workspace:copy-branch-name",
    );

    expect(contribution?.keywords).toContain("feature/login");
    contribution?.run();
    expect(withBranch.copiedBranchNames).toBe(1);
  });

  it("flips the pin label on pinned state and omits the entry when the host cannot pin", () => {
    const unpinned = source({ primary: null, secondary: [], menu: [] });
    unpinned.value.capabilities.canPin = true;
    const pinContribution = buildWorkspaceCommandCenterContributions(unpinned.value).find(
      (item) => item.id === "workspace:pin",
    );
    expect(pinContribution?.presentation).toMatchObject({ title: "Pin to top" });
    expect(pinContribution?.visibility).toBe("always");
    pinContribution?.run();
    expect(unpinned.dispatched).toEqual([{ id: "workspace.pin", scope: "sidebar" }]);

    const pinned = source({ primary: null, secondary: [], menu: [] });
    pinned.value.capabilities.canPin = true;
    pinned.value.isPinned = true;
    expect(
      buildWorkspaceCommandCenterContributions(pinned.value).find(
        (item) => item.id === "workspace:pin",
      )?.presentation,
    ).toMatchObject({ title: "Unpin" });

    const unsupported = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(unsupported.value).some(
        (item) => item.id === "workspace:pin",
      ),
    ).toBe(false);
  });

  it("lists Show setup only when the workspace has setup to show", () => {
    const withoutSetup = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(withoutSetup.value).some(
        (item) => item.id === "workspace:show-setup",
      ),
    ).toBe(false);

    const withSetup = source({ primary: null, secondary: [], menu: [] });
    withSetup.value.capabilities.canShowSetup = true;
    buildWorkspaceCommandCenterContributions(withSetup.value)
      .find((item) => item.id === "workspace:show-setup")
      ?.run();

    expect(withSetup.dispatched).toEqual([{ id: "workspace.setup.show", scope: "workspace" }]);
  });

  // Regression guard for the registration split: these two are handled only by workspace-screen.tsx
  // behind `enabled: isRouteFocused && ...`, so they must be built here rather than in the global
  // root set, where they would silently no-op off a workspace route.
  it("builds the Explorer sidebar and focus toggles in the workspace set", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities.canSplitPanes = false;
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    contributions.find((item) => item.id === "workspace:toggle-explorer-sidebar")?.run();
    contributions.find((item) => item.id === "workspace:toggle-focus-mode")?.run();

    expect(fixture.dispatched).toEqual([
      { id: "sidebar.toggle.right", scope: "sidebar" },
      { id: "workspace.focus.toggle", scope: "workspace" },
    ]);
    for (const contribution of contributions) {
      expect(contribution.group).toBe("workspace");
    }
  });

  // `buildPaneContributions` dispatches this same action as `pane:focus-mode-toggle` once split
  // panes are available, so the standalone entry must step aside there — otherwise the palette
  // lists "Toggle focus mode" twice for the one `workspace.focus.toggle` action.
  it("omits the standalone focus toggle when the pane set already covers it", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities.canSplitPanes = true;
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    const focusToggles = contributions.filter(
      (item) =>
        item.presentation.kind === "action" && item.presentation.title === "Toggle focus mode",
    );
    expect(focusToggles).toHaveLength(1);
    expect(focusToggles[0]?.id).toBe("pane:focus-mode-toggle");
  });

  it("omits the labels group when the catalog hasn't loaded", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.some((item) => item.id.startsWith("workspace:label:"))).toBe(false);
  });

  it("lists a choice per catalog label, ticked when assigned, and toggles the opposite state on run", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.labelCatalog = [
      { name: "bug", assigned: true },
      { name: "urgent", assigned: false },
    ];

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);
    const bug = contributions.find((item) => item.id === "workspace:label:bug");
    const urgent = contributions.find((item) => item.id === "workspace:label:urgent");

    expect(bug?.presentation).toMatchObject({
      kind: "choice",
      path: ["Labels", "bug"],
      selected: true,
    });
    expect(urgent?.presentation).toMatchObject({
      kind: "choice",
      path: ["Labels", "urgent"],
      selected: false,
    });

    bug?.run();
    urgent?.run();

    expect(fixture.toggledLabels).toEqual([
      { name: "bug", assigned: false },
      { name: "urgent", assigned: true },
    ]);
  });
});
