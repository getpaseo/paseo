/**
 * iOS fleet Live Activity controller implementation. Imported by `use-live-activity.ios.ts`
 * and unit tests; non-iOS builds use the no-op `use-live-activity.ts` stub instead.
 */

import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import { deriveFleetAgentInputs } from "./fleet-agent-input";
import { selectFleetSnapshot, type FleetAgentState, type FleetSnapshot } from "./fleet-snapshot";
import * as presenter from "./presenter";

export interface UseLiveActivityOptions {
  serverId: string;
}

const UPDATE_DEBOUNCE_MS = 1000;
const GRACE_PERIOD_MS = 120_000;

const EMPTY_AGENTS: ReadonlyMap<string, Agent> = new Map();
const EMPTY_TASKS: ReadonlyMap<string, TodoEntry[]> = new Map();

interface MaterialFleetState {
  heroId: string | null;
  heroState: FleetAgentState | null;
  needsYouCount: number;
  runningCount: number;
  phase: string | undefined;
  todoDone: number | undefined;
  todoTotal: number | undefined;
}

function materialState(snapshot: FleetSnapshot): MaterialFleetState {
  return {
    heroId: snapshot.hero?.agentId ?? null,
    heroState: snapshot.hero?.state ?? null,
    needsYouCount: snapshot.needsYouCount,
    runningCount: snapshot.runningCount,
    phase: snapshot.hero?.phase,
    todoDone: snapshot.hero?.todoDone,
    todoTotal: snapshot.hero?.todoTotal,
  };
}

function materialStateChanged(a: MaterialFleetState, b: MaterialFleetState): boolean {
  return (
    a.heroId !== b.heroId ||
    a.heroState !== b.heroState ||
    a.needsYouCount !== b.needsYouCount ||
    a.runningCount !== b.runningCount ||
    a.phase !== b.phase ||
    a.todoDone !== b.todoDone ||
    a.todoTotal !== b.todoTotal
  );
}

interface ActivityLifecycle {
  activityStartMs: number | null;
  lastHeroTitle: string;
  lastMaterial: MaterialFleetState | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  pendingSnapshot: FleetSnapshot | null;
  presenterEpoch: number;
  inFlightUpdate: Promise<void> | null;
}

function createActivityLifecycle(): ActivityLifecycle {
  return {
    activityStartMs: null,
    lastHeroTitle: "",
    lastMaterial: null,
    debounceTimer: null,
    graceTimer: null,
    pendingSnapshot: null,
    presenterEpoch: 0,
    inFlightUpdate: null,
  };
}

function clearPendingUpdate(lifecycle: ActivityLifecycle): void {
  if (lifecycle.debounceTimer !== null) {
    clearTimeout(lifecycle.debounceTimer);
    lifecycle.debounceTimer = null;
  }
  lifecycle.pendingSnapshot = null;
}

function clearGraceTimer(lifecycle: ActivityLifecycle): void {
  if (lifecycle.graceTimer === null) {
    return;
  }
  clearTimeout(lifecycle.graceTimer);
  lifecycle.graceTimer = null;
}

async function runPresenterUpdate(
  lifecycle: ActivityLifecycle,
  snapshot: FleetSnapshot,
): Promise<void> {
  const epoch = lifecycle.presenterEpoch;
  if (lifecycle.activityStartMs === null) {
    return;
  }
  const updatePromise = (async () => {
    try {
      await presenter.update(snapshot);
    } catch {
      return;
    }
    if (lifecycle.presenterEpoch !== epoch || lifecycle.activityStartMs === null) {
      return;
    }
    lifecycle.lastMaterial = materialState(snapshot);
  })();
  lifecycle.inFlightUpdate = updatePromise;
  try {
    await updatePromise;
  } finally {
    if (lifecycle.inFlightUpdate === updatePromise) {
      lifecycle.inFlightUpdate = null;
    }
  }
}

function scheduleDebouncedUpdate(lifecycle: ActivityLifecycle, snapshot: FleetSnapshot): void {
  clearPendingUpdate(lifecycle);
  lifecycle.pendingSnapshot = snapshot;
  lifecycle.debounceTimer = setTimeout(() => {
    lifecycle.debounceTimer = null;
    const pending = lifecycle.pendingSnapshot;
    lifecycle.pendingSnapshot = null;
    if (lifecycle.activityStartMs === null || pending === null) {
      return;
    }
    void runPresenterUpdate(lifecycle, pending);
  }, UPDATE_DEBOUNCE_MS);
}

function endActivity(lifecycle: ActivityLifecycle): void {
  lifecycle.presenterEpoch += 1;
  clearPendingUpdate(lifecycle);
  clearGraceTimer(lifecycle);
  if (lifecycle.activityStartMs === null) {
    return;
  }
  const receipt = {
    durationMs: Date.now() - lifecycle.activityStartMs,
    finishedTitle: lifecycle.lastHeroTitle,
  };
  lifecycle.activityStartMs = null;
  lifecycle.lastMaterial = null;
  const inFlight = lifecycle.inFlightUpdate;
  if (inFlight === null) {
    void presenter.end(receipt).catch(() => undefined);
    return;
  }
  void (async () => {
    await inFlight.catch(() => undefined);
    try {
      await presenter.end(receipt);
    } catch {
      return;
    }
  })();
}

function reconcileActivity(lifecycle: ActivityLifecycle, snapshot: FleetSnapshot): void {
  if (snapshot.hero !== null) {
    lifecycle.lastHeroTitle = snapshot.hero.title;
  }

  if (!snapshot.active) {
    if (lifecycle.activityStartMs !== null && lifecycle.graceTimer === null) {
      clearPendingUpdate(lifecycle);
      lifecycle.graceTimer = setTimeout(() => {
        lifecycle.graceTimer = null;
        endActivity(lifecycle);
      }, GRACE_PERIOD_MS);
    }
    return;
  }

  clearGraceTimer(lifecycle);

  if (lifecycle.activityStartMs === null) {
    lifecycle.presenterEpoch += 1;
    lifecycle.activityStartMs = Date.now();
    lifecycle.lastMaterial = materialState(snapshot);
    clearPendingUpdate(lifecycle);
    void presenter.start(snapshot).catch(() => undefined);
    return;
  }

  const nextMaterial = materialState(snapshot);
  if (
    lifecycle.lastMaterial !== null &&
    !materialStateChanged(lifecycle.lastMaterial, nextMaterial)
  ) {
    return;
  }

  scheduleDebouncedUpdate(lifecycle, snapshot);
}

export function useLiveActivityController({ serverId }: UseLiveActivityOptions): void {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { agents, agentTasks } = useSessionStore(
    useShallow((state) => ({
      agents: state.sessions[serverId]?.agents,
      agentTasks: state.sessions[serverId]?.agentTasks,
    })),
  );

  const prevHeroAgentIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef<ActivityLifecycle>(createActivityLifecycle());

  const snapshot = useMemo(() => {
    const inputs = deriveFleetAgentInputs(agents ?? EMPTY_AGENTS, agentTasks ?? EMPTY_TASKS);
    const result = selectFleetSnapshot(inputs, prevHeroAgentIdRef.current);
    prevHeroAgentIdRef.current = result.hero?.agentId ?? null;
    return result;
  }, [agents, agentTasks]);

  useEffect(() => {
    if (!presenter.supported()) {
      return;
    }
    if (!isConnected) {
      endActivity(lifecycleRef.current);
      prevHeroAgentIdRef.current = null;
      return;
    }
    reconcileActivity(lifecycleRef.current, snapshot);
  }, [isConnected, snapshot]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    return () => {
      endActivity(lifecycle);
      prevHeroAgentIdRef.current = null;
    };
  }, []);
}
