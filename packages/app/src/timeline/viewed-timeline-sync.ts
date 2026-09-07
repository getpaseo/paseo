import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import {
  planTimelineCatchUpAfter,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";
import {
  createAgentStreamReducerQueue,
  scheduleAgentStreamReducerFlush,
  cancelAgentStreamReducerFlush,
  type AgentStreamReducerEvent,
} from "./session-stream-reducers";
import type { TimelineReplica, TimelineResponsePayload, TimelinePageRequest } from "./replica";
import type { AgentRemovalReason } from "@/utils/agent-directory-sync";

export interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

export interface ViewedTimelineSyncPorts {
  initialDeliveryMode: TimelineDeliveryMode;
  prepare(agentId: string): Promise<void>;
  replaceDemandedAgentIds(agentIds: string[]): void;
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

export interface ViewedTimelineDemandDeclaration {
  replace(agentIds: string[]): void;
  dispose(): void;
}

export interface ViewedTimelineUiBridge {
  registerVisibleAgentIds(sourceId: string, agentIds: string[]): ViewedTimelineDemandDeclaration;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  getAgentTimelineError(agentId: string): string | null;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  setDeliveryMode(mode: TimelineDeliveryMode): void;
  recoverGap(
    agentId: string,
    cursor: { epoch: string; endSeq: number },
    observedSeq?: number,
  ): void;
  beginAgentLifetime(agentId: string): void;
  endAgentLifetime(agentId: string): void;
  dispose(): void;
}

export type ViewedTimelineOwnerPorts = Omit<
  ViewedTimelineSyncPorts,
  "prepare" | "replaceDemandedAgentIds" | "readCursor"
>;

export interface ViewedTimelineOwner extends ViewedTimelineSync {
  beginTimelineRequest(
    agentId: string,
    replaceTail?: boolean,
  ): (payload: TimelineResponsePayload) => void;
  applyTimelineResponse(payload: TimelineResponsePayload): void;
  enqueueStreamEvent(agentId: string, event: AgentStreamReducerEvent): void;
  flushStreamAgent(agentId: string): void;
  attachTransport(ports: ViewedTimelineOwnerPorts): () => void;
  acceptAgent(agentId: string): void;
  removeAgent(agentId: string, reason: AgentRemovalReason): void;
}

export function createViewedTimelineOwner(input: {
  serverId: string;
  replica: TimelineReplica;
  replaceDemandedAgentIds: (agentIds: string[]) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
  ports?: ViewedTimelineOwnerPorts;
}): ViewedTimelineOwner {
  let transport = input.ports;
  const requireTransport = () => {
    if (!transport) throw new Error("Timeline transport is disconnected");
    return transport;
  };
  const sync = createViewedTimelineSync({
    initialDeliveryMode: transport?.initialDeliveryMode ?? "legacy",
    setSubscription: (ids) => requireTransport().setSubscription(ids),
    fetchPage: (id, request) => requireTransport().fetchPage(id, request),
    fetchLatestTail: (id) => requireTransport().fetchLatestTail(id),
    reportError: (error) => transport?.reportError(error),
    schedule: (task, delay) => {
      if (transport) return transport.schedule(task, delay);
      const timeout = setTimeout(task, delay);
      return () => clearTimeout(timeout);
    },
    prepare: (agentId) => input.replica.prepare(agentId),
    readCursor: (agentId) => input.replica.readCursor(agentId),
    replaceDemandedAgentIds: input.replaceDemandedAgentIds,
  });
  const streamQueue = createAgentStreamReducerQueue({
    apply: (agentId, events) => input.replica.applyEvents(agentId, events, sync.recoverGap),
    scheduleFlush: scheduleAgentStreamReducerFlush,
    cancelFlush: cancelAgentStreamReducerFlush,
  });
  function applyTimelineResponse(
    payload: TimelineResponsePayload,
    request?: TimelinePageRequest,
  ): void {
    streamQueue.flushAgent(payload.agentId);
    input.replica.applyPage(
      payload,
      {
        recoverGap: (agentId, cursor, observedSeq) => sync.recoverGap(agentId, cursor, observedSeq),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      },
      request,
    );
  }

  return {
    ...sync,
    attachTransport(ports) {
      sync.setConnected(false);
      transport = ports;
      sync.setDeliveryMode(ports.initialDeliveryMode);
      return () => {
        if (transport !== ports) return;
        sync.setConnected(false);
        transport = undefined;
      };
    },
    acceptAgent(agentId) {
      input.replica.acceptAgent(agentId);
      sync.beginAgentLifetime(agentId);
    },
    removeAgent(agentId, reason) {
      streamQueue.flushAgent(agentId);
      sync.endAgentLifetime(agentId);
      input.replica.remove(agentId, reason);
    },
    beginTimelineRequest(agentId, replaceTail = false) {
      const request = {
        cursor: input.replica.readCursor(agentId) ?? null,
        replaceTail,
        initialization: getInitDeferred(getInitKey(input.serverId, agentId))?.promise,
      };
      return (payload) => applyTimelineResponse(payload, request);
    },
    applyTimelineResponse,
    enqueueStreamEvent(agentId, event) {
      streamQueue.enqueue(agentId, event);
    },
    flushStreamAgent(agentId) {
      streamQueue.flushAgent(agentId);
    },
    dispose() {
      streamQueue.dispose({ flush: true });
      sync.dispose();
    },
  };
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

interface VisibleAgentSource {
  declaration: object;
  agentIds: string[];
}

const getNextRetryDelayMs = (previousDelayMs: number | undefined): number => {
  if (previousDelayMs == null) {
    return RETRY_DELAY_MS;
  }
  return Math.min(previousDelayMs * 2, MAX_RETRY_DELAY_MS);
};

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, VisibleAgentSource>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  // The newest live sequence each agent has been told about but whose coverage is not yet
  // established. A catch-up is complete only when authoritative coverage reaches it; a page
  // built before that sequence existed cannot settle it, however it was requested.
  const observedHeads = new Map<string, { epoch: string; seq: number }>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Map<string, string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
  const loadedCache = new Set<string>();
  const cacheLoads = new Map<string, Promise<void>>();
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

  const visibleAgentIds = () =>
    normalizeAgentIds([...sources.values()].flatMap((source) => source.agentIds));

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

  const setVisibilityCatchUpError = (agentIds: string[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const agentId of agentIds) {
      if (manualRetries.delete(agentId)) changed = true;
      if (visibilityCatchUpPending.delete(agentId)) changed = true;
      if (visibilityCatchUpErrors.get(agentId) !== message) {
        visibilityCatchUpErrors.set(agentId, message);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  };

  // Cancelling forgets the observed head: the next catch-up starts from the current cursor and
  // the daemon returns everything after it.
  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    observedHeads.delete(agentId);
  };

  const owedAfter = (
    agentId: string,
    cursorBefore: { epoch: string; endSeq: number } | undefined,
    observedBefore: { epoch: string; seq: number } | undefined,
  ): ProjectedTimelineForwardFetchPlan | undefined => {
    const observed = observedHeads.get(agentId);
    const cursor = ports.readCursor(agentId);
    if (!observed || !cursor) return undefined;
    const advanced =
      cursorBefore === undefined ||
      cursorBefore.epoch !== cursor.epoch ||
      cursor.endSeq > cursorBefore.endSeq;
    if (cursor.epoch === observed.epoch && cursor.endSeq < observed.seq) {
      if (!advanced && observed === observedBefore)
        throw new Error(
          `Timeline coverage for ${agentId} has not reached observed sequence ${observed.seq}`,
        );
      return planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq });
    }
    observedHeads.delete(agentId);
    return undefined;
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
    fallbackToLatestTailOnOverflow: boolean,
  ): Promise<void> => {
    if (!ownsCatchUp(agentId, generation)) return;

    try {
      let cursorBefore = ports.readCursor(agentId);
      let observedBefore = observedHeads.get(agentId);
      const page = await ports.fetchPage(agentId, request);
      if (!ownsCatchUp(agentId, generation)) return;
      if (page.hasNewer && page.endCursor) {
        if (
          request.direction === "after" &&
          page.endCursor.epoch === request.cursor.epoch &&
          page.endCursor.seq <= request.cursor.seq
        ) {
          throw new Error(`Timeline page for ${agentId} did not advance its cursor`);
        }
        if (fallbackToLatestTailOnOverflow) {
          cursorBefore = ports.readCursor(agentId);
          observedBefore = observedHeads.get(agentId);
          await ports.fetchLatestTail(agentId);
          if (!ownsCatchUp(agentId, generation)) return;
        } else {
          await fetchUntilCurrent(
            agentId,
            generation,
            planTimelineCatchUpAfter(page.endCursor),
            false,
          );
          return;
        }
      } else if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      const owed = owedAfter(agentId, cursorBefore, observedBefore);
      if (owed) {
        await fetchUntilCurrent(agentId, generation, owed, false);
        return;
      }
      catchUps.set(agentId, { generation, status: "complete" });
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
        setVisibilityCatchUpError([agentId], error);
        ports.reportError(error);
      }
    }
  };

  const ensureCacheLoaded = (agentId: string): void => {
    if (loadedCache.has(agentId) || cacheLoads.has(agentId)) return;
    const load = ports
      .prepare(agentId)
      .catch((error) => ports.reportError(error))
      .finally(() => {
        if (cacheLoads.get(agentId) !== load) return;
        cacheLoads.delete(agentId);
        loadedCache.add(agentId);
        startCatchUp(agentId);
      });
    cacheLoads.set(agentId, load);
  };

  // One catch-up per agent: it runs from the current cursor until the daemon reports nothing
  // newer and coverage reaches every observed sequence. A running catch-up is never replaced
  // by another request; it finishes its own obligation. `supersede` restarts a failed or
  // completed one immediately, which the manual retry and a new gap both need.
  const startCatchUp = (agentId: string, options: { supersede?: boolean } = {}) => {
    const { supersede = false } = options;
    if (!connected || !isDesired(agentId) || !isAcknowledged(agentId)) return;
    if (!loadedCache.has(agentId)) {
      ensureCacheLoaded(agentId);
      return;
    }
    const current = catchUps.get(agentId);
    if (current?.status === "running") return;
    if (current?.status === "complete" && !supersede) return;
    current?.cancelRetry?.();
    const request = planTimelineResumeFetch(ports.readCursor(agentId));
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    const retryDelayMs =
      supersede || current?.status !== "error" ? undefined : current.retryDelayMs;
    catchUps.set(agentId, { generation, status: "running", request, retryDelayMs });
    // A resume with no observed head replays at most one bounded page before taking the latest
    // tail; a catch-up that owes observed live rows pages forward until it reaches them.
    const resumingWithoutObservation = request.direction === "after" && !observedHeads.has(agentId);
    void fetchUntilCurrent(agentId, generation, request, resumingWithoutObservation);
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) startCatchUp(agentId);
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
      setVisibilityCatchUpError(requested, error);
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

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = deliveryMode === "selective" && membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { supersede: true });
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
        ensureCacheLoaded(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    ports.replaceDemandedAgentIds(desired);
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
    getAgentTimelineError(agentId) {
      return visibilityCatchUpErrors.get(agentId) ?? null;
    },
    registerVisibleAgentIds(sourceId, agentIds) {
      const declaration = {};
      sources.set(sourceId, {
        declaration,
        agentIds: normalizeAgentIds(agentIds),
      });
      publishVisibleMembership();
      return {
        replace(nextAgentIds) {
          const current = sources.get(sourceId);
          if (current?.declaration !== declaration) return;
          current.agentIds = normalizeAgentIds(nextAgentIds);
          publishVisibleMembership();
        },
        dispose() {
          if (sources.get(sourceId)?.declaration !== declaration) return;
          sources.delete(sourceId);
          publishVisibleMembership();
        },
      };
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
      ports.replaceDemandedAgentIds(desired);
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      for (const agentId of desired) visibilityCatchUpPending.add(agentId);
      acknowledged = deliveryMode === "legacy" && connected ? desired : [];
      notifyListeners();
      if (deliveryMode === "selective" && connected) void reconcileMembership();
      else if (connected) startAcknowledgedCatchUps();
    },
    recoverGap(agentId, cursor, observedSeq) {
      if (!isDesired(agentId)) return;
      if (observedSeq !== undefined) {
        const observed = observedHeads.get(agentId);
        if (!observed || observed.epoch !== cursor.epoch || observed.seq < observedSeq) {
          observedHeads.set(agentId, { epoch: cursor.epoch, seq: observedSeq });
        }
      }
      startCatchUp(agentId, { supersede: true });
    },
    beginAgentLifetime(agentId) {
      if (!isDesired(agentId)) return;
      visibilityCatchUpPending.add(agentId);
      ensureCacheLoaded(agentId);
      notifyListeners();
    },
    endAgentLifetime(agentId) {
      cancelCatchUp(agentId);
      loadedCache.delete(agentId);
      cacheLoads.delete(agentId);
      if (isDesired(agentId)) {
        visibilityCatchUpPending.add(agentId);
        notifyListeners();
      }
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
      ports.replaceDemandedAgentIds([]);
      acknowledged = [];
      recentlyViewedAgentIds = [];
      loadedCache.clear();
      cacheLoads.clear();
      observedHeads.clear();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      notifyListeners();
      listeners.clear();
    },
    retryVisibleAgentTimeline,
  };
}
