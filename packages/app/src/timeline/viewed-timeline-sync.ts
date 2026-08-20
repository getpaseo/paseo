import {
  planTimelineCatchUpAfter,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";

interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

interface ViewedTimelineSyncPorts {
  initialDeliveryMode: TimelineDeliveryMode;
  setSubscription(agentIds: string[]): Promise<void>;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  fetchLatestTail(agentId: string): Promise<TimelinePageResult>;
  reportError(error: unknown): void;
  schedule(task: () => void, delayMs: number): () => void;
}

export type TimelineDeliveryMode = "legacy" | "selective";
export type ViewedTimelineStatus = "ready" | "pending" | "error" | "retrying";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  setDeliveryMode(mode: TimelineDeliveryMode): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const VIEWED_TIMELINE_HOT_AGENT_LIMIT = 5;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
  retryDelayMs?: number;
}

const getNextRetryDelayMs = (previousDelayMs: number | undefined): number => {
  if (previousDelayMs == null) {
    return RETRY_DELAY_MS;
  }
  return Math.min(previousDelayMs * 2, MAX_RETRY_DELAY_MS);
};

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

type CatchUpDecision = "keep" | "keep-and-park" | "replace";

function decideCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan;
  supersede: boolean;
}): CatchUpDecision {
  if (!input.current) return "replace";
  if (input.supersede) {
    if (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    ) {
      return "keep";
    }
    if (input.current.status === "running" && input.current.request?.direction === "tail") {
      return "keep-and-park";
    }
    return "replace";
  }
  return input.current.status === "running" || input.current.status === "complete"
    ? "keep"
    : "replace";
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
  // Authoritative fetch owed but not runnable yet: disconnected, unacknowledged, or parked.
  // Acknowledgement and tail completion are the only drain points.
  const pendingCatchUps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Set<string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
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
  let membershipRetryDelayMs: number | undefined;
  let cancelMembershipRetry: (() => void) | null = null;
  let recentlyViewedAgentIds: string[] = [];

  const visibleAgentIds = () => normalizeAgentIds([...sources.values()].flat());

  const selectHotAgentIds = (visible: string[]) => {
    const visibleSet = new Set(visible);
    recentlyViewedAgentIds = [
      ...visible,
      ...recentlyViewedAgentIds.filter((agentId) => !visibleSet.has(agentId)),
    ];
    const hiddenBudget = Math.max(0, VIEWED_TIMELINE_HOT_AGENT_LIMIT - visible.length);
    const desiredAgentIds = normalizeAgentIds([
      ...visible,
      ...recentlyViewedAgentIds
        .filter((agentId) => !visibleSet.has(agentId))
        .slice(0, hiddenBudget),
    ]);
    const desiredSet = new Set(desiredAgentIds);
    recentlyViewedAgentIds = recentlyViewedAgentIds.filter((agentId) => desiredSet.has(agentId));
    return desiredAgentIds;
  };

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);
  const ownsCatchUp = (agentId: string, generation: number) =>
    !disposed &&
    connected &&
    isDesired(agentId) &&
    isAcknowledged(agentId) &&
    catchUps.get(agentId)?.generation === generation;

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    const wasRetrying = manualRetries.delete(agentId);
    if (wasPending || hadError || wasRetrying) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[]) => {
    let changed = false;
    for (const agentId of agentIds) {
      if (manualRetries.delete(agentId)) changed = true;
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
    pendingCatchUps.delete(agentId);
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
    fallbackToLatestTailOnOverflow: boolean,
  ): Promise<void> => {
    if (!ownsCatchUp(agentId, generation)) return;

    try {
      const page = await ports.fetchPage(agentId, request);
      if (!ownsCatchUp(agentId, generation)) return;
      if (page.hasNewer && page.endCursor) {
        if (fallbackToLatestTailOnOverflow) {
          await ports.fetchLatestTail(agentId);
          catchUps.set(agentId, { generation, status: "complete" });
          setVisibilityCatchUpReady(agentId);
          return;
        }
        await fetchUntilCurrent(
          agentId,
          generation,
          planTimelineCatchUpAfter(page.endCursor),
          false,
        );
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      const pendingCatchUp = pendingCatchUps.get(agentId);
      if (pendingCatchUp) {
        startCatchUp(agentId, { request: pendingCatchUp, supersede: true });
        return;
      }
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation) {
        const nextRetryDelayMs = getNextRetryDelayMs(catchUps.get(agentId)?.retryDelayMs);
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, nextRetryDelayMs);
        catchUps.set(agentId, {
          generation,
          status: "error",
          request,
          cancelRetry,
          retryDelayMs: nextRetryDelayMs,
        });
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
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    const nextRequest = request ?? planTimelineResumeFetch(ports.readCursor(agentId));
    const current = catchUps.get(agentId);
    const decision = decideCatchUp({ current, request: nextRequest, supersede });
    if (decision === "keep-and-park") {
      pendingCatchUps.set(agentId, nextRequest);
      return;
    }
    if (decision === "keep") {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    const retryDelayMs =
      supersede || current?.status !== "error" ? undefined : current.retryDelayMs;
    catchUps.set(agentId, {
      generation,
      status: "running",
      request: nextRequest,
      retryDelayMs,
    });
    pendingCatchUps.delete(agentId);
    void fetchUntilCurrent(
      agentId,
      generation,
      nextRequest,
      request === undefined && nextRequest.direction === "after",
    );
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) {
      const pendingCatchUp = pendingCatchUps.get(agentId);
      startCatchUp(agentId, {
        request: pendingCatchUp,
        supersede: Boolean(pendingCatchUp),
      });
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
      const nextRetryDelayMs = getNextRetryDelayMs(membershipRetryDelayMs);
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
      }, nextRetryDelayMs);
      membershipRetryDelayMs = nextRetryDelayMs;
      ports.reportError(error);
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
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

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = deliveryMode === "selective" && membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { request: catchUp.request, supersede: true });
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    membershipNeedsRetry = false;
    void reconcileMembership();
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
        if (manualRetries.delete(agentId)) statusChanged = true;
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
        manualRetries.delete(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
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

  const publishVisibleMembership = () => {
    const visible = visibleAgentIds();
    if (!connected || deliveryMode !== "selective") {
      const activeVisible = active ? visible : [];
      recentlyViewedAgentIds = activeVisible;
      commitDesiredMembership(activeVisible);
      return;
    }
    if (!active) return;
    commitDesiredMembership(selectHotAgentIds(visible));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (manualRetries.has(agentId)) return "retrying";
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (!isDesired(agentId) || visibilityCatchUpPending.has(agentId)) return "pending";
      return "ready";
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      publishVisibleMembership();
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishVisibleMembership();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        const visible = active ? visibleAgentIds() : [];
        recentlyViewedAgentIds = visible;
        commitDesiredMembership(visible, { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        membershipRetryDelayMs = undefined;
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
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipRetryDelayMs = undefined;
      membershipNeedsRetry = false;
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      const visible = active ? visibleAgentIds() : [];
      recentlyViewedAgentIds = visible;
      desired = visible;
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
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
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipRetryDelayMs = undefined;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      acknowledged = [];
      recentlyViewedAgentIds = [];
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      notifyListeners();
      listeners.clear();
    },
    retryVisibleAgentTimeline,
  };
}
