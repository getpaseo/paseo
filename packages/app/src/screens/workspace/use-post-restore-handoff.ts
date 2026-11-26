import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceRouteState } from "@/screens/workspace/workspace-route-state";
import type { ViewedTimelineStatus } from "@/timeline/viewed-timeline-sync";

type ArchivedWorkspaceRouteState = Extract<WorkspaceRouteState, { kind: "archived" }>;

const POST_RESTORE_HANDOFF_TIMEOUT_MS = 2_500;
const POST_RESTORE_LAYOUT_SETTLE_FRAMES = 3;
const EMPTY_SHEETS: readonly { tab: { target: { kind: string; agentId?: string } } }[] = [];

export function areAutoOpenAgentTabsReconciled(input: {
  autoOpenAgentIds: ReadonlySet<string>;
  hiddenAgentIds: ReadonlySet<string>;
  openAgentIds: ReadonlySet<string>;
}): boolean {
  for (const agentId of input.autoOpenAgentIds) {
    if (input.hiddenAgentIds.has(agentId)) continue;
    if (!input.openAgentIds.has(agentId)) return false;
  }
  return true;
}

function scheduleAnimationFrames(remaining: number, callback: () => void): () => void {
  let frameId: number | null = null;
  let cancelled = false;
  const step = (left: number) => {
    if (cancelled) return;
    if (left <= 0) {
      callback();
      return;
    }
    frameId = requestAnimationFrame(() => step(left - 1));
  };
  step(remaining);
  return () => {
    cancelled = true;
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}

export function canSyncVisibleAgents(
  isRouteFocused: boolean,
  routeStateKind: WorkspaceRouteState["kind"],
  hasActiveWorkspace: boolean,
): boolean {
  if (!isRouteFocused) return false;
  switch (routeStateKind) {
    case "ready":
    case "reconnecting":
    case "loading":
      return true;
    case "archived":
      return hasActiveWorkspace;
    case "unreachable":
    case "missing":
    case "needsHostUpgrade":
    case "recoveryUnavailable":
    case "recoveryInspectionFailed":
      return false;
  }
}

export interface PostRestoreHandoffState {
  scopeKey: string;
  archivedState: ArchivedWorkspaceRouteState;
}

export function nextPostRestoreHandoff(input: {
  current: PostRestoreHandoffState | null;
  scopeKey: string;
  routeState: WorkspaceRouteState;
}): PostRestoreHandoffState | null {
  const { current, scopeKey, routeState } = input;
  if (
    routeState.kind === "archived" &&
    routeState.recovery.kind === "recoverable" &&
    routeState.recovery.phase === "restoring"
  ) {
    if (current !== null && current.scopeKey === scopeKey) {
      return current;
    }
    return { scopeKey, archivedState: routeState };
  }
  if (current === null) return null;
  if (current.scopeKey !== scopeKey || routeState.kind !== "ready") {
    return null;
  }
  return current;
}

export function resolvePostRestoreDisplayedRouteState(input: {
  handoff: PostRestoreHandoffState | null;
  scopeKey: string;
  hasActiveWorkspace: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasReconciledAutoOpenAgentTabs: boolean;
  visibleAgentCount: number;
  visibleAgentsTimelineSynced: boolean;
  visibleAgentsVisibilityStatus: ViewedTimelineStatus;
  visibleAgentsLoadingOlder: boolean;
  routeState: WorkspaceRouteState;
}): {
  displayedRouteState: WorkspaceRouteState;
  isWaitingForHandoffReveal: boolean;
  isHandoffReadyToMount: boolean;
  isHandoffReadyToRelease: boolean;
} {
  const {
    handoff,
    scopeKey,
    hasActiveWorkspace,
    hasHydratedWorkspaceLayoutStore,
    hasHydratedAgents,
    hasReconciledAutoOpenAgentTabs,
    visibleAgentCount,
    visibleAgentsTimelineSynced,
    visibleAgentsVisibilityStatus,
    visibleAgentsLoadingOlder,
    routeState,
  } = input;
  const isRestoringNow =
    routeState.kind === "archived" && routeState.recovery.phase === "restoring";
  const hasActiveHandoff = handoff !== null && handoff.scopeKey === scopeKey;
  const isWaitingForHandoffReveal =
    hasActiveHandoff && !isRestoringNow && hasActiveWorkspace && routeState.kind === "ready";
  const hasReconciledTabs =
    hasHydratedWorkspaceLayoutStore && hasHydratedAgents && hasReconciledAutoOpenAgentTabs;
  // Wait for every visible agent pane's authoritative tail sync and viewedTimelineSync catch-up
  // ("ready" or "error") so follow-up `dir=after` requests finish before reveal instead of
  // flashing the "Updating..." toast right after the gate drops.
  const areVisibleAgentsReadyToMount =
    visibleAgentCount === 0 ||
    visibleAgentsVisibilityStatus === "error" ||
    (visibleAgentsTimelineSynced && visibleAgentsVisibilityStatus === "ready");
  const isHandoffReadyToMount = hasReconciledTabs && areVisibleAgentsReadyToMount;
  const isHandoffReadyToRelease =
    isHandoffReadyToMount &&
    (visibleAgentsVisibilityStatus === "error" || !visibleAgentsLoadingOlder);
  return {
    displayedRouteState: isWaitingForHandoffReveal ? handoff.archivedState : routeState,
    isWaitingForHandoffReveal,
    isHandoffReadyToMount,
    isHandoffReadyToRelease,
  };
}

/**
 * Holds the `Restoring...` recovery gate across the brief handoff after the daemon marks
 * a workspace active while tabs reconcile, tab labels measure, and visible agent panes'
 * timelines catch up, so the UI cuts in one frame from `Restoring...` to the settled workspace.
 */
export function usePostRestoreWorkspaceRouteState(input: {
  serverId: string;
  workspaceId: string;
  persistenceKey: string | null;
  hasActiveWorkspace: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  autoOpenAgentIds: ReadonlySet<string>;
  hiddenAgentIds: ReadonlySet<string>;
  uiTabs: readonly { target: { kind: string; agentId?: string } }[];
  visibleAgentIds: readonly string[];
  routeState: WorkspaceRouteState;
  isRouteFocused: boolean;
  paneFocusSuspended: boolean;
}): {
  displayedRouteState: WorkspaceRouteState;
  isHoldingHandoff: boolean;
  isPaneRouteFocused: boolean;
  effectivePaneFocusSuspended: boolean;
} {
  const {
    serverId,
    workspaceId,
    persistenceKey,
    hasActiveWorkspace,
    hasHydratedWorkspaceLayoutStore,
    hasHydratedAgents,
    autoOpenAgentIds,
    hiddenAgentIds,
    uiTabs,
    visibleAgentIds,
    routeState,
    isRouteFocused,
    paneFocusSuspended,
  } = input;

  const scopeKey = `${serverId}:${workspaceId}`;
  const [handoff, setHandoff] = useState<PostRestoreHandoffState | null>(null);
  const [mountedHandoff, setMountedHandoff] = useState<PostRestoreHandoffState | null>(null);

  const reconciledHandoff = nextPostRestoreHandoff({ current: handoff, scopeKey, routeState });
  if (reconciledHandoff !== handoff) {
    setHandoff(reconciledHandoff);
  }
  if (mountedHandoff !== null && mountedHandoff !== reconciledHandoff) {
    setMountedHandoff(null);
  }

  const workspaceSheets = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.sheetsByWorkspace[persistenceKey] ?? EMPTY_SHEETS) : EMPTY_SHEETS,
  );
  const openAgentIds = new Set<string>();
  for (const tab of uiTabs) {
    if (tab.target.kind === "agent" && tab.target.agentId) {
      openAgentIds.add(tab.target.agentId);
    }
  }
  for (const sheet of workspaceSheets) {
    if (sheet.tab.target.kind === "agent" && sheet.tab.target.agentId) {
      openAgentIds.add(sheet.tab.target.agentId);
    }
  }
  const hasReconciledAutoOpenAgentTabs = areAutoOpenAgentTabsReconciled({
    autoOpenAgentIds,
    hiddenAgentIds,
    openAgentIds,
  });

  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const visibleAgentsTimelineSynced = useSessionStore((state) => {
    if (visibleAgentIds.length === 0) return true;
    const session = state.sessions[serverId];
    return visibleAgentIds.every(
      (agentId) => selectAgentTimelineState(session, agentId).status === "synced",
    );
  });
  const visibleAgentsLoadingOlder = useSessionStore((state) => {
    if (visibleAgentIds.length === 0) return false;
    const inFlight = state.sessions[serverId]?.agentTimelineOlderFetchInFlight;
    return visibleAgentIds.some((agentId) => inFlight?.get(agentId) === true);
  });
  const subscribeTimeline = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTimelineStatus = useCallback((): ViewedTimelineStatus => {
    if (visibleAgentIds.length === 0 || !viewedTimelineSync) return "ready";
    let allReady = true;
    for (const agentId of visibleAgentIds) {
      const status = viewedTimelineSync.getAgentTimelineStatus(agentId);
      if (status === "error") return "error";
      if (status !== "ready") allReady = false;
    }
    return allReady ? "ready" : "checking";
  }, [viewedTimelineSync, visibleAgentIds]);
  const visibleAgentsVisibilityStatus = useSyncExternalStore(
    subscribeTimeline,
    readTimelineStatus,
    readTimelineStatus,
  );

  const {
    displayedRouteState,
    isWaitingForHandoffReveal,
    isHandoffReadyToMount,
    isHandoffReadyToRelease,
  } = resolvePostRestoreDisplayedRouteState({
    handoff: reconciledHandoff,
    scopeKey,
    hasActiveWorkspace,
    hasHydratedWorkspaceLayoutStore,
    hasHydratedAgents,
    hasReconciledAutoOpenAgentTabs,
    visibleAgentCount: visibleAgentIds.length,
    visibleAgentsTimelineSynced,
    visibleAgentsVisibilityStatus,
    visibleAgentsLoadingOlder,
    routeState,
  });

  // Once workspace chrome mounts behind the overlay, keep it mounted for this handoff even if
  // an underfilled multi-page chat triggers an older-history fill before reveal.
  const isMountedBehindOverlay =
    isWaitingForHandoffReveal &&
    (isHandoffReadyToMount || (mountedHandoff !== null && mountedHandoff === reconciledHandoff));
  if (isMountedBehindOverlay && mountedHandoff !== reconciledHandoff) {
    setMountedHandoff(reconciledHandoff);
  }

  useEffect(() => {
    if (!isWaitingForHandoffReveal) return;
    if (isHandoffReadyToRelease) {
      // Wait 3 rAFs after hidden workspace chrome mounts so tab label `onLayout` and stream row
      // ResizeObservers commit (and any underfilled history fetch starts) before lifting overlay.
      return scheduleAnimationFrames(POST_RESTORE_LAYOUT_SETTLE_FRAMES, () => {
        setHandoff(null);
      });
    }
    const timer = setTimeout(() => {
      setHandoff(null);
    }, POST_RESTORE_HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isHandoffReadyToRelease, isWaitingForHandoffReveal]);

  return {
    displayedRouteState,
    isHoldingHandoff: isMountedBehindOverlay,
    isPaneRouteFocused: isRouteFocused && !isMountedBehindOverlay,
    effectivePaneFocusSuspended: paneFocusSuspended || isMountedBehindOverlay,
  };
}
