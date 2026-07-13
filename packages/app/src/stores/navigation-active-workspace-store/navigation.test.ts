import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import {
  navigateToLastWorkspace,
  navigateToWorkspace,
  parseActiveWorkspaceSelection,
  type NavigateToLastWorkspaceDeps,
  type NavigateToWorkspaceDeps,
} from "./navigation";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

interface RecordedTab {
  workspaceKey: string;
  target: WorkspaceTabTarget;
}

function createFakeDeps(overrides: Partial<NavigateToWorkspaceDeps> = {}) {
  const navigations: string[] = [];
  const remembered: ActiveWorkspaceSelection[] = [];
  const openedTabs: RecordedTab[] = [];
  const deps: NavigateToWorkspaceDeps = {
    getSessionWorkspaces: () => null,
    getSessionAgents: () => [] as Agent[],
    openTabFocused: (workspaceKey, target) => {
      openedTabs.push({ workspaceKey, target });
      return target.kind === "agent" ? target.agentId : null;
    },
    pinAgent: () => undefined,
    rememberLastWorkspace: (selection) => remembered.push(selection),
    navigateToRoute: (route) => navigations.push(route),
    ...overrides,
  };
  return { deps, navigations, remembered, openedTabs };
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

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

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
    const { deps, openedTabs } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

    expect(openedTabs).toEqual([
      {
        workspaceKey: "server-1:workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
      },
    ]);
  });

  it("keeps an explicit tab authoritative over an attention agent", () => {
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
    const { deps, openedTabs } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
    });

    navigateToWorkspace(
      {
        serverId: "server-1",
        workspaceId: "workspace-a",
        target: { kind: "draft", draftId: "draft-1" },
      },
      deps,
    );

    expect(openedTabs).toEqual([
      {
        workspaceKey: "server-1:workspace-a",
        target: { kind: "draft", draftId: "draft-1" },
      },
    ]);
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

  it("ignores stale workspace route params while an app-wide route is active", () => {
    const selection = parseActiveWorkspaceSelection({
      pathname: "/settings/general",
      params: {
        serverId: "server-1",
        workspaceId: "workspace-a",
      },
    });

    expect(selection).toBeNull();
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
