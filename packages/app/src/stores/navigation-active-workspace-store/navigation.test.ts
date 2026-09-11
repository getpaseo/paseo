import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
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
  pin: boolean;
}

interface RecordedEphemeralReveal {
  workspaceKey: string;
  target: WorkspaceTabTarget;
}

function createFakeDeps(overrides: Partial<NavigateToWorkspaceDeps> = {}) {
  const navigations: string[] = [];
  const remembered: ActiveWorkspaceSelection[] = [];
  const openedTabs: RecordedTab[] = [];
  const ephemeralReveals: RecordedEphemeralReveal[] = [];
  const deferredUntilHydrated: Array<() => void> = [];
  // Mirrors the layout store's memory-only reveal entries: a hold records the
  // target, the workspace screen deletes it when the user leaves, and settling
  // acts only on a target that is still held.
  const heldReveals = new Map<string, WorkspaceTabTarget>();
  let lastSelection: ActiveWorkspaceSelection | null = null;
  const deps: NavigateToWorkspaceDeps = {
    getSessionWorkspaces: () => null,
    getSessionAgents: () => [] as Agent[],
    isWorkspaceLayoutHydrated: () => true,
    onWorkspaceLayoutHydrated: (callback) => deferredUntilHydrated.push(callback),
    openTab: ({ workspaceKey, target, pin = false }) => {
      openedTabs.push({ workspaceKey, target, pin });
      return target.kind === "agent" ? target.agentId : null;
    },
    revealEphemeralTab: ({ workspaceKey, target }) => {
      ephemeralReveals.push({ workspaceKey, target });
    },
    holdEphemeralTab: ({ workspaceKey, target }) => {
      heldReveals.set(workspaceKey, target);
    },
    settleHeldEphemeralTab: ({ workspaceKey, target, reveal }) => {
      const held = heldReveals.get(workspaceKey);
      if (!held || !workspaceTabTargetsEqual(held, target)) {
        return;
      }
      if (reveal) {
        ephemeralReveals.push({ workspaceKey, target });
      } else {
        heldReveals.delete(workspaceKey);
      }
    },
    // Mirrors the real store: every navigation updates the current selection.
    getLastWorkspaceSelection: () => lastSelection,
    rememberLastWorkspace: (selection) => {
      lastSelection = selection;
      remembered.push(selection);
    },
    navigateToRoute: (route) => navigations.push(route),
    ...overrides,
  };
  return {
    deps,
    navigations,
    remembered,
    openedTabs,
    ephemeralReveals,
    deferredUntilHydrated,
    heldReveals,
  };
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

  it("reveals the attention agent's tab without persisting a focus change", () => {
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
    const { deps, openedTabs, ephemeralReveals } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

    expect(ephemeralReveals).toEqual([
      {
        workspaceKey: "server-1:workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
      },
    ]);
    expect(openedTabs).toEqual([]);
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
    const { deps, openedTabs, ephemeralReveals } = createFakeDeps({
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
        pin: false,
      },
    ]);
    expect(ephemeralReveals).toEqual([]);
  });

  it("defers an agent tab until a missing workspace is recovered", () => {
    const { deps, navigations, openedTabs } = createFakeDeps({
      getSessionWorkspaces: () => new Map(),
    });

    navigateToWorkspace(
      {
        serverId: "server-1",
        workspaceId: "workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
      },
      deps,
    );

    expect(openedTabs).toEqual([]);
    expect(navigations).toEqual(["/h/server-1/workspace/workspace-a?open=agent%3Aagent-1"]);
  });

  it("defers an agent tab until persisted workspace layout has hydrated", () => {
    const workspace = {
      id: "workspace-a",
      workspaceDirectory: "/repo/workspace-a",
    } as WorkspaceDescriptor;
    const { deps, navigations, openedTabs } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      isWorkspaceLayoutHydrated: () => false,
    });

    navigateToWorkspace(
      {
        serverId: "server-1",
        workspaceId: "workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
        pin: true,
      },
      deps,
    );

    expect(openedTabs).toEqual([]);
    expect(navigations).toEqual(["/h/server-1/workspace/workspace-a?open=agent%3Aagent-1"]);
  });

  it("records no reveal when no agent needs attention", () => {
    const workspace = {
      id: "workspace-a",
      workspaceDirectory: "/repo/workspace-a",
    } as WorkspaceDescriptor;
    const agent = {
      id: "agent-1",
      cwd: "/repo/workspace-a",
      workspaceId: "workspace-a",
      requiresAttention: false,
    } as unknown as Agent;
    const { deps, openedTabs, ephemeralReveals } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

    expect(ephemeralReveals).toEqual([]);
    expect(openedTabs).toEqual([]);
  });

  it("defers the attention reveal until the persisted workspace layout has hydrated", () => {
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
    const { deps, openedTabs, ephemeralReveals, deferredUntilHydrated, heldReveals } =
      createFakeDeps({
        getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
        getSessionAgents: () => [agent],
        isWorkspaceLayoutHydrated: () => false,
      });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

    // Deferred, not dropped: hydration would otherwise reconcile the tabs onto
    // the saved focus with nothing retrying the reveal, while an agent still
    // needs attention.
    expect(ephemeralReveals).toEqual([]);
    expect(heldReveals.get("server-1:workspace-a")).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(deferredUntilHydrated).toHaveLength(1);

    deferredUntilHydrated[0]?.();
    expect(ephemeralReveals).toEqual([
      {
        workspaceKey: "server-1:workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
      },
    ]);
    expect(openedTabs).toEqual([]);
  });

  it("drops a deferred attention reveal when the user has moved on", () => {
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
    const { deps, ephemeralReveals, deferredUntilHydrated, heldReveals } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
      isWorkspaceLayoutHydrated: () => false,
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);
    // The user moves on to another workspace before hydration finishes and
    // before the screen they left mounted to clear the held reveal, so the
    // selection check is what drops it.
    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-b" }, deps);

    deferredUntilHydrated[0]?.();

    expect(ephemeralReveals).toEqual([]);
    expect(heldReveals.has("server-1:workspace-a")).toBe(false);
  });

  it("drops a deferred attention reveal whose visit ended on an app-wide route", () => {
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
    const { deps, ephemeralReveals, deferredUntilHydrated, heldReveals } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
      isWorkspaceLayoutHydrated: () => false,
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);
    // Leaving for settings keeps the remembered selection on workspace-a, but
    // the workspace screen clears the held reveal as the user leaves.
    heldReveals.delete("server-1:workspace-a");

    deferredUntilHydrated[0]?.();

    expect(ephemeralReveals).toEqual([]);
  });

  it("applies a deferred attention reveal when its workspace is still current", () => {
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
    const { deps, ephemeralReveals, deferredUntilHydrated } = createFakeDeps({
      getSessionWorkspaces: () => new Map([[workspace.id, workspace]]),
      getSessionAgents: () => [agent],
      isWorkspaceLayoutHydrated: () => false,
    });

    navigateToWorkspace({ serverId: "server-1", workspaceId: "workspace-a" }, deps);

    deferredUntilHydrated[0]?.();

    expect(ephemeralReveals).toEqual([
      {
        workspaceKey: "server-1:workspace-a",
        target: { kind: "agent", agentId: "agent-1" },
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

  // Desktop cold-starts at "/" (packages/desktop/src/main.ts) and restores the
  // remembered workspace, so a workspace is mounted while the pathname carries
  // no workspace at all. Anything that identifies the active workspace from the
  // pathname alone silently gets nothing there — and reports that workspace's
  // panes as closed.
  it("resolves a workspace the pathname alone cannot identify", () => {
    const params = { serverId: "server-1", workspaceId: "workspace-a" };

    expect(parseHostWorkspaceRouteFromPathname("/")).toBeNull();
    expect(parseActiveWorkspaceSelection({ pathname: "/", params })).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
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
