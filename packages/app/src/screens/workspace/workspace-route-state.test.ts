import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import { resolveWorkspaceRouteState, type WorkspaceRouteState } from "./workspace-route-state";
import {
  areAutoOpenAgentTabsReconciled,
  canSyncVisibleAgents,
  nextPostRestoreHandoff,
  resolvePostRestoreDisplayedRouteState,
} from "./use-post-restore-handoff";

function createWorkspaceDescriptor(): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    diffStat: null,
    scripts: [],
    archivingAt: null,
    statusEnteredAt: null,
  };
}

function resolve(input: {
  workspace?: WorkspaceDescriptor | null;
  connectionStatus?: "online" | "offline";
  hasHydratedWorkspaces?: boolean;
  recovery?: WorkspaceRecoveryModel;
}) {
  return resolveWorkspaceRouteState({
    hostName: "Laptop",
    connectionStatus: input.connectionStatus ?? "online",
    lastError: input.connectionStatus === "offline" ? "transport closed" : null,
    workspace: input.workspace ?? null,
    hasHydratedWorkspaces: input.hasHydratedWorkspaces ?? true,
    recovery: input.recovery ?? { kind: "checking" },
  });
}

const recoverable = {
  kind: "recoverable",
  recovery: {
    kind: "recoverable",
    workspaceId: "workspace-1",
    workspaceName: "Feature branch",
    action: "restore",
    branch: "feature",
  },
  phase: "ready",
  error: null,
} as const satisfies WorkspaceRecoveryModel;

describe("resolveWorkspaceRouteState", () => {
  it("keeps a missing route unreachable while its host is offline", () => {
    expect(resolve({ connectionStatus: "offline" })).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("keeps a cached workspace visible while its host reconnects", () => {
    expect(
      resolve({ workspace: createWorkspaceDescriptor(), connectionStatus: "offline" }),
    ).toEqual({
      kind: "reconnecting",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("waits for workspace hydration and authoritative recovery inspection", () => {
    expect(resolve({ hasHydratedWorkspaces: false })).toEqual({
      kind: "loading",
      hostName: "Laptop",
    });
    expect(resolve({ recovery: { kind: "checking" } })).toEqual({
      kind: "loading",
      hostName: "Laptop",
    });
  });

  it("keeps an ordinary missing route distinct from an explicit recovery request", () => {
    expect(resolve({ recovery: { kind: "idle" } })).toEqual({
      kind: "missing",
      hostName: "Laptop",
    });
    expect(resolve({ recovery: { kind: "needsHostUpgrade" } })).toEqual({
      kind: "needsHostUpgrade",
      hostName: "Laptop",
    });
  });

  it("renders the authoritative archived-workspace state through ready, restoring, and failed phases", () => {
    expect(resolve({ recovery: recoverable })).toEqual({
      kind: "archived",
      hostName: "Laptop",
      recovery: recoverable,
    });

    const restoring = { ...recoverable, phase: "restoring" as const };
    expect(resolve({ recovery: restoring })).toMatchObject({
      kind: "archived",
      recovery: { phase: "restoring" },
    });

    const failed = {
      ...recoverable,
      phase: "failed" as const,
      error: "Project root is missing",
    };
    expect(resolve({ recovery: failed })).toMatchObject({
      kind: "archived",
      recovery: { phase: "failed", error: "Project root is missing" },
    });
  });

  it("distinguishes unsupported and authoritatively unavailable workspaces", () => {
    expect(resolve({ recovery: { kind: "needsHostUpgrade" } })).toEqual({
      kind: "needsHostUpgrade",
      hostName: "Laptop",
    });
    expect(
      resolve({
        recovery: {
          kind: "unavailable",
          recovery: {
            kind: "unavailable",
            workspaceId: "workspace-1",
            reason: "workspace_directory_missing",
            message: "The workspace directory cannot be recreated.",
          },
        },
      }),
    ).toEqual({
      kind: "recoveryUnavailable",
      hostName: "Laptop",
      message: "The workspace directory cannot be recreated.",
    });

    expect(
      resolve({
        recovery: {
          kind: "unsupportedAction",
          action: "repair_from_snapshot",
        },
      }),
    ).toEqual({
      kind: "recoveryUnavailable",
      hostName: "Laptop",
      message: "Update Paseo to recover this workspace.",
    });
  });

  it("keeps loading visible when the descriptor arrives, then uses it as the success transition", () => {
    const restoring = { ...recoverable, phase: "restoring" as const };
    expect(
      resolve({
        workspace: createWorkspaceDescriptor(),
        recovery: restoring,
      }),
    ).toEqual({ kind: "archived", hostName: "Laptop", recovery: restoring });

    expect(
      resolve({
        workspace: createWorkspaceDescriptor(),
        recovery: recoverable,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("allows visible agent sync during loading and once a recovering workspace becomes active", () => {
    const cases: Array<[WorkspaceRouteState["kind"], boolean, boolean]> = [
      ["ready", true, true],
      ["reconnecting", true, true],
      ["loading", false, true],
      ["archived", false, false],
      ["archived", true, true],
      ["missing", false, false],
      ["unreachable", false, false],
      ["needsHostUpgrade", false, false],
      ["recoveryUnavailable", false, false],
      ["recoveryInspectionFailed", false, false],
    ];
    for (const [kind, hasActiveWorkspace, expected] of cases) {
      expect(canSyncVisibleAgents(true, kind, hasActiveWorkspace)).toBe(expected);
      expect(canSyncVisibleAgents(false, kind, hasActiveWorkspace)).toBe(false);
    }
  });
});

describe("post-restore handoff state machine", () => {
  const scopeKey = "srv_1:workspace-1";
  const restoringState: Extract<WorkspaceRouteState, { kind: "archived" }> = {
    kind: "archived",
    hostName: "Laptop",
    recovery: { ...recoverable, phase: "restoring" },
  };

  it("holds Restoring across archived->ready until tabs reconcile and focused timeline syncs", () => {
    const captured = nextPostRestoreHandoff({
      current: null,
      scopeKey,
      routeState: restoringState,
    });
    expect(captured).toEqual({ scopeKey, archivedState: restoringState });

    const duringReady = nextPostRestoreHandoff({
      current: captured,
      scopeKey,
      routeState: { kind: "ready" },
    });
    expect(duringReady).toBe(captured);

    // Waiting on tabs to reconcile.
    const waitingTabs = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: false,
      visibleAgentCount: 0,
      visibleAgentsTimelineSynced: true,
      visibleAgentsVisibilityStatus: "ready",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(waitingTabs.displayedRouteState).toBe(restoringState);
    expect(waitingTabs.isWaitingForHandoffReveal).toBe(true);
    expect(waitingTabs.isHandoffReadyToMount).toBe(false);
    expect(waitingTabs.isHandoffReadyToRelease).toBe(false);

    // Tabs reconciled, waiting on visible agent panes (including split panes) to sync.
    const waitingTimeline = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 2,
      visibleAgentsTimelineSynced: false,
      visibleAgentsVisibilityStatus: "checking",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(waitingTimeline.displayedRouteState).toBe(restoringState);
    expect(waitingTimeline.isHandoffReadyToMount).toBe(false);
    expect(waitingTimeline.isHandoffReadyToRelease).toBe(false);

    // Tail synced, but follow-up catch-up still checking -> keep holding so "Updating..." never flashes.
    const waitingCatchUp = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 2,
      visibleAgentsTimelineSynced: true,
      visibleAgentsVisibilityStatus: "checking",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(waitingCatchUp.displayedRouteState).toBe(restoringState);
    expect(waitingCatchUp.isHandoffReadyToMount).toBe(false);
    expect(waitingCatchUp.isHandoffReadyToRelease).toBe(false);

    // Underfilled multi-page history loading older rows -> stay mounted behind overlay without releasing.
    const waitingOlderFill = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 1,
      visibleAgentsTimelineSynced: true,
      visibleAgentsVisibilityStatus: "ready",
      visibleAgentsLoadingOlder: true,
      routeState: { kind: "ready" },
    });
    expect(waitingOlderFill.isHandoffReadyToMount).toBe(true);
    expect(waitingOlderFill.isHandoffReadyToRelease).toBe(false);

    // Timeline synced, catch-up ready, and not loading older -> ready to release after settle rAFs.
    const revealed = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 2,
      visibleAgentsTimelineSynced: true,
      visibleAgentsVisibilityStatus: "ready",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(revealed.displayedRouteState).toBe(restoringState);
    expect(revealed.isWaitingForHandoffReveal).toBe(true);
    expect(revealed.isHandoffReadyToMount).toBe(true);
    expect(revealed.isHandoffReadyToRelease).toBe(true);

    // Once handoff is cleared, routeState is returned directly.
    const cleared = resolvePostRestoreDisplayedRouteState({
      handoff: null,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 2,
      visibleAgentsTimelineSynced: true,
      visibleAgentsVisibilityStatus: "ready",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(cleared.displayedRouteState).toEqual({ kind: "ready" });
    expect(cleared.isWaitingForHandoffReveal).toBe(false);

    // Catch-up error also marks handoff ready to release immediately so the error callout is shown.
    const errored = resolvePostRestoreDisplayedRouteState({
      handoff: duringReady,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 1,
      visibleAgentsTimelineSynced: false,
      visibleAgentsVisibilityStatus: "error",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(errored.isHandoffReadyToRelease).toBe(true);
  });

  it("marks handoff ready to release immediately when the workspace only has non-auto-open agents", () => {
    const captured = nextPostRestoreHandoff({
      current: null,
      scopeKey,
      routeState: restoringState,
    });
    const resolved = resolvePostRestoreDisplayedRouteState({
      handoff: captured,
      scopeKey,
      hasActiveWorkspace: true,
      hasHydratedWorkspaceLayoutStore: true,
      hasHydratedAgents: true,
      hasReconciledAutoOpenAgentTabs: true,
      visibleAgentCount: 0,
      visibleAgentsTimelineSynced: false,
      visibleAgentsVisibilityStatus: "ready",
      visibleAgentsLoadingOlder: false,
      routeState: { kind: "ready" },
    });
    expect(resolved.isHandoffReadyToRelease).toBe(true);
  });

  it("requires every non-hidden auto-open agent tab to be reconciled, not just any existing tab", () => {
    const autoOpenAgentIds = new Set(["agent-1", "agent-2"]);
    // Existing terminal or partial agent tab is not enough until agent-2 is reconciled too.
    expect(
      areAutoOpenAgentTabsReconciled({
        autoOpenAgentIds,
        hiddenAgentIds: new Set(),
        openAgentIds: new Set(["agent-1"]),
      }),
    ).toBe(false);
    // Explicitly hidden agents do not block reconciliation.
    expect(
      areAutoOpenAgentTabsReconciled({
        autoOpenAgentIds,
        hiddenAgentIds: new Set(["agent-2"]),
        openAgentIds: new Set(["agent-1"]),
      }),
    ).toBe(true);
    // Once all non-hidden auto-open agents are open, reconciliation is complete.
    expect(
      areAutoOpenAgentTabsReconciled({
        autoOpenAgentIds,
        hiddenAgentIds: new Set(),
        openAgentIds: new Set(["agent-1", "agent-2"]),
      }),
    ).toBe(true);
  });

  it("resets handoff on disconnect, failure, non-restoring archived states, or workspace switch", () => {
    const captured = nextPostRestoreHandoff({
      current: null,
      scopeKey,
      routeState: restoringState,
    });

    const resetCases: WorkspaceRouteState[] = [
      {
        kind: "reconnecting",
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "closed",
      },
      { kind: "unreachable", hostName: "Laptop", connectionStatus: "offline", lastError: "closed" },
      { kind: "loading", hostName: "Laptop" },
      { kind: "missing", hostName: "Laptop" },
      { kind: "recoveryUnavailable", hostName: "Laptop", message: "missing" },
      { kind: "recoveryInspectionFailed", hostName: "Laptop", error: "boom" },
      {
        kind: "archived",
        hostName: "Laptop",
        recovery: { ...recoverable, phase: "failed", error: "err" },
      },
      { kind: "archived", hostName: "Laptop", recovery: { ...recoverable, phase: "ready" } },
    ];
    for (const nextState of resetCases) {
      expect(
        nextPostRestoreHandoff({ current: captured, scopeKey, routeState: nextState }),
      ).toBeNull();
    }

    // Switching workspaces also resets.
    expect(
      nextPostRestoreHandoff({
        current: captured,
        scopeKey: "srv_1:workspace-2",
        routeState: { kind: "ready" },
      }),
    ).toBeNull();
  });
});
