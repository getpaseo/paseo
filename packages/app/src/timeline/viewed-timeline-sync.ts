import type { AgentTimelineCursorState } from "@/stores/session-store";
import {
  planInitialAgentTimelineSync,
  planResumeTimelineSync,
  planTimelineCatchUpAfter,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";

interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

interface ViewedTimelineSyncPorts {
  initialDeliveryMode: TimelineDeliveryMode;
  setSubscription(agentIds: string[]): Promise<void>;
  readCursor(agentId: string): AgentTimelineCursorState | undefined;
  hasAuthoritativeHistory(agentId: string): boolean;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  reportError(error: unknown): void;
  schedule(task: () => void, delayMs: number): () => void;
}

export type TimelineDeliveryMode = "legacy" | "selective";
export type ViewedTimelineStatus = "ready" | "pending" | "error";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  setDeliveryMode(mode: TimelineDeliveryMode): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

const RETRY_DELAY_MS = 1_000;
export const VIEWED_TIMELINE_UNSUBSCRIBE_GRACE_MS = 5_000;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
}

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

function shouldKeepCurrentCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan | undefined;
  supersede: boolean;
}): boolean {
  if (!input.current) return false;
  if (input.supersede) {
    return (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    );
  }
  return input.current.status === "running" || input.current.status === "complete";
}

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, string[]>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  const pendingGaps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const lingeringRemovals = new Map<string, () => void>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Set<string>();
  const listeners = new Set<() => void>();
  let active = true;
  let connected = false;
  let deliveryMode = ports.initialDeliveryMode;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let reconciling = false;
  let reconcileRequested = false;
  let membershipNeedsRetry = false;
  let cancelMembershipRetry: (() => void) | null = null;

  const visibleAgentIds = () => (active ? normalizeAgentIds([...sources.values()].flat()) : []);
  const effectiveAgentIds = () =>
    normalizeAgentIds([...visibleAgentIds(), ...lingeringRemovals.keys()]);

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    if (wasPending || hadError) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[]) => {
    let changed = false;
    for (const agentId of agentIds) {
      if (!visibilityCatchUpPending.delete(agentId)) continue;
      visibilityCatchUpErrors.add(agentId);
      changed = true;
    }
    if (changed) notifyListeners();
  };

  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    pendingGaps.delete(agentId);
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<void> => {
    if (
      disposed ||
      !connected ||
      !isDesired(agentId) ||
      !isAcknowledged(agentId) ||
      catchUps.get(agentId)?.generation !== generation
    ) {
      return;
    }

    try {
      const page = await ports.fetchPage(agentId, request);
      if (
        disposed ||
        !connected ||
        !isDesired(agentId) ||
        !isAcknowledged(agentId) ||
        catchUps.get(agentId)?.generation !== generation
      ) {
        return;
      }
      if (page.hasNewer && page.endCursor) {
        await fetchUntilCurrent(agentId, generation, planTimelineCatchUpAfter(page.endCursor));
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation) {
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, RETRY_DELAY_MS);
        catchUps.set(agentId, { generation, status: "error", cancelRetry });
        setVisibilityCatchUpError([agentId]);
        ports.reportError(error);
      }
    }
  };

  const startCatchUp = (
    agentId: string,
    options: {
      request?: ProjectedTimelineForwardFetchPlan;
      supersede?: boolean;
    } = {},
  ) => {
    const { request, supersede = false } = options;
    if (!connected || !isDesired(agentId) || !isAcknowledged(agentId)) {
      if (request) pendingGaps.set(agentId, request);
      return;
    }
    const current = catchUps.get(agentId);
    if (shouldKeepCurrentCatchUp({ current, request, supersede })) {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    catchUps.set(agentId, { generation, status: "running", request });
    pendingGaps.delete(agentId);
    const cursor = ports.readCursor(agentId);
    const nextRequest =
      request ??
      (ports.hasAuthoritativeHistory(agentId)
        ? planResumeTimelineSync({ cursor })
        : planInitialAgentTimelineSync({ cursor, hasAuthoritativeHistory: false }));
    void fetchUntilCurrent(agentId, generation, nextRequest);
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) {
      const gap = pendingGaps.get(agentId);
      startCatchUp(agentId, { request: gap, supersede: Boolean(gap) });
    }
  };

  const reconcileLatestMembership = async (): Promise<void> => {
    if (disposed || !connected || deliveryMode !== "selective") return;
    const generation = membershipGeneration;
    const requested = desired;
    if (!membershipNeedsRetry && sameAgentIds(requested, acknowledged)) return;
    membershipNeedsRetry = false;
    try {
      await ports.setSubscription(requested);
    } catch (error) {
      membershipNeedsRetry = true;
      setVisibilityCatchUpError(requested);
      cancelMembershipRetry?.();
      cancelMembershipRetry = ports.schedule(() => {
        cancelMembershipRetry = null;
        if (
          disposed ||
          !connected ||
          membershipGeneration !== generation ||
          !sameAgentIds(desired, requested)
        ) {
          return;
        }
        void reconcileMembership();
      }, RETRY_DELAY_MS);
      ports.reportError(error);
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    if (disposed || !connected || deliveryMode !== "selective") return;
    acknowledged = requested;
    if (generation !== membershipGeneration) {
      await reconcileLatestMembership();
      return;
    }
    startAcknowledgedCatchUps();
    if (!sameAgentIds(desired, acknowledged)) await reconcileLatestMembership();
  };

  const reconcileMembership = async () => {
    if (reconciling) {
      reconcileRequested = true;
      return;
    }
    if (disposed || !connected) return;
    reconciling = true;
    try {
      await reconcileLatestMembership();
    } finally {
      reconciling = false;
      if (reconcileRequested && !disposed && connected && deliveryMode === "selective") {
        reconcileRequested = false;
        void reconcileMembership();
      } else if (
        !disposed &&
        connected &&
        deliveryMode === "selective" &&
        !membershipNeedsRetry &&
        !sameAgentIds(desired, acknowledged)
      ) {
        void reconcileMembership();
      }
    }
  };

  const retryFailedCatchUps = () => {
    for (const agentId of acknowledged) {
      if (catchUps.get(agentId)?.status === "error") startCatchUp(agentId);
    }
  };

  const commitDesiredMembership = (
    nextDesired: string[],
    options: { resetCatchUpStatus?: boolean } = {},
  ) => {
    let statusChanged = false;
    if (options.resetCatchUpStatus) {
      for (const agentId of nextDesired) {
        if (!visibilityCatchUpPending.has(agentId)) {
          visibilityCatchUpPending.add(agentId);
          statusChanged = true;
        }
        if (visibilityCatchUpErrors.delete(agentId)) statusChanged = true;
      }
    }
    if (sameAgentIds(nextDesired, desired)) {
      if (statusChanged) notifyListeners();
      if (deliveryMode === "selective" && membershipNeedsRetry) void reconcileMembership();
      retryFailedCatchUps();
      return;
    }

    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) {
        cancelCatchUp(agentId);
        visibilityCatchUpPending.delete(agentId);
        visibilityCatchUpErrors.delete(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    membershipGeneration += 1;
    notifyListeners();
    if (deliveryMode === "legacy") {
      acknowledged = connected ? desired : [];
      if (connected) startAcknowledgedCatchUps();
      return;
    }
    void reconcileMembership();
  };

  const clearLingeringRemovals = () => {
    for (const cancel of lingeringRemovals.values()) cancel();
    lingeringRemovals.clear();
  };

  const publishVisibleMembership = (allowGrace: boolean) => {
    const visible = visibleAgentIds();
    for (const agentId of visible) {
      lingeringRemovals.get(agentId)?.();
      lingeringRemovals.delete(agentId);
    }

    if (allowGrace && connected && deliveryMode === "selective") {
      for (const agentId of desired) {
        if (visible.includes(agentId) || lingeringRemovals.has(agentId)) continue;
        const cancel = ports.schedule(() => {
          lingeringRemovals.delete(agentId);
          commitDesiredMembership(effectiveAgentIds());
        }, VIEWED_TIMELINE_UNSUBSCRIBE_GRACE_MS);
        lingeringRemovals.set(agentId, cancel);
      }
    } else {
      clearLingeringRemovals();
    }

    commitDesiredMembership(effectiveAgentIds());
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (!isDesired(agentId) || visibilityCatchUpPending.has(agentId)) return "pending";
      return "ready";
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      publishVisibleMembership(true);
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishVisibleMembership(true);
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        clearLingeringRemovals();
        commitDesiredMembership(visibleAgentIds(), { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        acknowledged = [];
        membershipGeneration += 1;
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      membershipGeneration += 1;
      if (deliveryMode === "legacy") {
        acknowledged = desired;
        startAcknowledgedCatchUps();
      } else {
        void reconcileMembership();
      }
    },
    setDeliveryMode(nextMode) {
      if (deliveryMode === nextMode) return;
      deliveryMode = nextMode;
      clearLingeringRemovals();
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = visibleAgentIds();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      for (const agentId of desired) visibilityCatchUpPending.add(agentId);
      acknowledged = deliveryMode === "legacy" && connected ? desired : [];
      notifyListeners();
      if (deliveryMode === "selective" && connected) void reconcileMembership();
      else if (connected) startAcknowledgedCatchUps();
    },
    recoverGap(agentId, cursor) {
      if (!isDesired(agentId)) return;
      startCatchUp(agentId, {
        request: planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        supersede: true,
      });
    },
    dispose() {
      disposed = true;
      clearLingeringRemovals();
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      acknowledged = [];
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      notifyListeners();
      listeners.clear();
    },
  };
}
