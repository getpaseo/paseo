import type { AgentTimelineCursorState } from "@/stores/session-store";
import {
  planResumeTimelineSync,
  planTimelineCatchUpAfter,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";

interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

interface ViewedTimelineSyncPorts {
  setSubscription(agentIds: string[]): Promise<void>;
  readCursor(agentId: string): AgentTimelineCursorState | undefined;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  reportError(error: unknown): void;
  scheduleRetry(retry: () => void): () => void;
}

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  cancelRetry?: () => void;
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
  let active = true;
  let connected = false;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let reconciling = false;
  let reconcileRequested = false;
  let membershipNeedsRetry = false;
  let cancelMembershipRetry: (() => void) | null = null;

  const effectiveAgentIds = () => (active ? normalizeAgentIds([...sources.values()].flat()) : []);

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);

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
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation) {
        const cancelRetry = ports.scheduleRetry(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        });
        catchUps.set(agentId, { generation, status: "error", cancelRetry });
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
    if (!supersede && (current?.status === "running" || current?.status === "complete")) {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    catchUps.set(agentId, { generation, status: "running" });
    pendingGaps.delete(agentId);
    const nextRequest = request ?? planResumeTimelineSync({ cursor: ports.readCursor(agentId) });
    void fetchUntilCurrent(agentId, generation, nextRequest);
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) {
      const gap = pendingGaps.get(agentId);
      startCatchUp(agentId, { request: gap, supersede: Boolean(gap) });
    }
  };

  const reconcileLatestMembership = async (): Promise<void> => {
    if (disposed || !connected) return;
    const generation = membershipGeneration;
    const requested = desired;
    if (!membershipNeedsRetry && sameAgentIds(requested, acknowledged)) return;
    membershipNeedsRetry = false;
    try {
      await ports.setSubscription(requested);
    } catch (error) {
      membershipNeedsRetry = true;
      cancelMembershipRetry?.();
      cancelMembershipRetry = ports.scheduleRetry(() => {
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
      });
      ports.reportError(error);
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    if (disposed || !connected) return;
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
      if (reconcileRequested && !disposed && connected) {
        reconcileRequested = false;
        void reconcileMembership();
      } else if (
        !disposed &&
        connected &&
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

  const publishEffectiveMembership = () => {
    const nextDesired = effectiveAgentIds();
    if (sameAgentIds(nextDesired, desired)) {
      if (membershipNeedsRetry) void reconcileMembership();
      retryFailedCatchUps();
      return;
    }

    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) cancelCatchUp(agentId);
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    membershipGeneration += 1;
    void reconcileMembership();
  };

  return {
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      publishEffectiveMembership();
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishEffectiveMembership();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        acknowledged = [];
        membershipGeneration += 1;
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      membershipGeneration += 1;
      void reconcileMembership();
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
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      acknowledged = [];
    },
  };
}
