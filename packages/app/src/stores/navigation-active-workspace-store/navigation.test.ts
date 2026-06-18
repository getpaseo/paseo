import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import {
  navigateToLastWorkspace,
  navigateToWorkspace,
  parseActiveWorkspaceSelection,
  type NavigateToLastWorkspaceDeps,
  type NavigateToWorkspaceDeps,
} from "./navigation";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

interface RecordedAgentTab {
  workspaceKey: string;
  agentId: string;
}

function createFakeDeps(overrides: Partial<NavigateToWorkspaceDeps> = {}) {
  const navigations: string[] = [];
  const remembered: ActiveWorkspaceSelection[] = [];
  const openedAgentTabs: RecordedAgentTab[] = [];
  const deps: NavigateToWorkspaceDeps = {
    getSessionWorkspaces: () => null,
    getSessionAgents: () => [] as Agent[],
    openWorkspaceAgentTab: (workspaceKey, agentId) =>
      openedAgentTabs.push({ workspaceKey, agentId }),
    rememberLastWorkspace: (selection) => remembered.push(selection),
    navigateToRoute: (route) => navigations.push(route),
    ...overrides,
  };
  return { deps, navigations, remembered, openedAgentTabs };
}

function createLastSelectionDeps(
  initial: ActiveWorkspaceSelection | null,
  overrides: Partial<NavigateToWorkspaceDeps> = {},
): {
  deps: NavigateToLastWorkspaceDeps;
  navigations: string[];
  remembered: ActiveWorkspaceSelection[];
} {
  let lastSelection = initial;
  const base = createFakeDeps({
    rememberLastWorkspace: (selection) => {
      lastSelection = selection;
      base.remembered.push(selection);
    },
    ...overrides,
  });
  return {
    deps: { ...base.deps, getLastWorkspaceSelection: () => lastSelection },
    navigations: base.navigations,
    remembered: base.remembered,
  };
}

describe("workspace navigation", () => {
  it("reports when no last workspace is known", () => {
    const { deps } = createLastSelectionDeps(null);

    expect(navigateToLastWorkspace(deps)).toBe(false);
  });

  it("navigates to a workspace route and remembers the selection", () => {
    const { deps, navigations, remembered } = createFakeDeps();

    navigateToWorkspace("server-1", "workspace-a", deps);

    expect(navigations).toEqual(["/h/server-1/workspace/workspace-a"]);
    expect(remembered).toEqual([{ serverId: "server-1", workspaceId: "workspace-a" }]);
  });

  it("focuses the attention agent's tab when a workspace has one", () => {
    const workspace = {
      id: "workspace-a",
      workspaceDirectory: "/repo/workspace-a",
    } as WorkspaceDescriptor;
    const agent = {
      id: "agent-1",
      cwd: "/repo/workspace-a",
      workspaceId: "workspace-a",
      requiresAttention: true,
      attentionReason: "permission",
    } as unknown as Agent;
    const { deps, openedAgentTabs } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
    });

    navigateToWorkspace("server-1", "workspace-a", deps);

    expect(openedAgentTabs).toEqual([{ workspaceKey: "server-1:workspace-a", agentId: "agent-1" }]);
  });

  it("reads the active workspace from the current route", () => {
    const selection = parseActiveWorkspaceSelection({
      pathname: "/h/server-1/workspace/workspace-a",
      params: {},
    });

    expect(selection).toEqual({ serverId: "server-1", workspaceId: "workspace-a" });
  });

  it("falls back to workspace route params during cold route mount", () => {
    const selection = parseActiveWorkspaceSelection({
      pathname: "/",
      params: {
        serverId: "server-1",
        workspaceId: "b64_L3RtcC9wYXNlby1taXNzaW5nLXdvcmtzcGFjZQ",
      },
    });

    expect(selection).toEqual({
      serverId: "server-1",
      workspaceId: "/tmp/paseo-missing-workspace",
    });
  });

  it("navigates to the last workspace once a route observation has been remembered", () => {
    const { deps, navigations } = createLastSelectionDeps(null);

    const observed = parseActiveWorkspaceSelection({
      pathname: "/h/server-1/workspace/workspace-a",
      params: {},
    });
    expect(observed).not.toBeNull();
    if (observed) {
      deps.rememberLastWorkspace(observed);
    }

    expect(navigateToLastWorkspace(deps)).toBe(true);
    expect(navigations).toEqual(["/h/server-1/workspace/workspace-a"]);
  });
});
