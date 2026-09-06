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
  permissionRequestId: string | undefined;
  permissionPrimaryActionId: string | undefined;
  permissionPrimaryActionLabel: string | undefined;
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
    permissionRequestId: snapshot.hero?.permissionRequestId,
    permissionPrimaryActionId: snapshot.hero?.permissionPrimaryAction?.id,
    permissionPrimaryActionLabel: snapshot.hero?.permissionPrimaryAction?.label,
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
    a.todoTotal !== b.todoTotal ||
    a.permissionRequestId !== b.permissionRequestId ||
    a.permissionPrimaryActionId !== b.permissionPrimaryActionId ||
    a.permissionPrimaryActionLabel !== b.permissionPrimaryActionLabel
  );
}

interface ActivityLifecycle {
  activityStartMs: number | null;
  lastHeroTitle: string;
  lastHeroAgentId: string;
  lastMaterial: MaterialFleetState | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  pendingSnapshot: FleetSnapshot | null;
  presenterEpoch: number;
  /** The currently running (or most recently chained) native start/update/end call, if any. */
  presenterInFlight: Promise<void> | null;
}

function createActivityLifecycle(): ActivityLifecycle {
  return {
    activityStartMs: null,
    lastHeroTitle: "",
    lastHeroAgentId: "",
    lastMaterial: null,
    debounceTimer: null,
    graceTimer: null,
    pendingSnapshot: null,
    presenterEpoch: 0,
    presenterInFlight: null,
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

/**
 * Runs one native call. When nothing is in flight, `task` runs immediately (synchronously up to
 * its first `await`), matching the pre-serialization dispatch latency. When a previous call is
 * still in flight, `task` is chained after it instead of racing it. Either way, a later call
 * always settles after an earlier one: a deferred `end` can't outrun an unresolved `start`, and a
 * stale `end` can't terminate a replacement activity that started after it was scheduled.
 */
function enqueuePresenterTask(
  lifecycle: ActivityLifecycle,
  task: () => Promise<void>,
): Promise<void> {
  const previous = lifecycle.presenterInFlight;
  const run =
    previous === null
      ? task().catch(() => undefined)
      : previous.then(() => task().catch(() => undefined));
  lifecycle.presenterInFlight = run;
  void run.finally(() => {
    if (lifecycle.presenterInFlight === run) {
      lifecycle.presenterInFlight = null;
    }
  });
  return run;
}

function runPresenterUpdate(lifecycle: ActivityLifecycle, snapshot: FleetSnapshot): Promise<void> {
  const epoch = lifecycle.presenterEpoch;
  return enqueuePresenterTask(lifecycle, async () => {
    if (lifecycle.presenterEpoch !== epoch || lifecycle.activityStartMs === null) {
      return;
    }
    await presenter.update(snapshot);
    if (lifecycle.presenterEpoch !== epoch || lifecycle.activityStartMs === null) {
      return;
    }
    lifecycle.lastMaterial = materialState(snapshot);
  });
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

function endActivity(lifecycle: ActivityLifecycle, serverId: string): void {
  lifecycle.presenterEpoch += 1;
  clearPendingUpdate(lifecycle);
  clearGraceTimer(lifecycle);
  if (lifecycle.activityStartMs === null) {
    return;
  }
  const receipt = {
    serverId,
    agentId: lifecycle.lastHeroAgentId,
    durationMs: Date.now() - lifecycle.activityStartMs,
    finishedTitle: lifecycle.lastHeroTitle,
  };
  lifecycle.activityStartMs = null;
  lifecycle.lastMaterial = null;
  void enqueuePresenterTask(lifecycle, () => presenter.end(receipt));
}

function reconcileActivity(
  lifecycle: ActivityLifecycle,
  snapshot: FleetSnapshot,
  serverId: string,
): void {
  if (snapshot.hero !== null) {
    lifecycle.lastHeroTitle = snapshot.hero.title;
    lifecycle.lastHeroAgentId = snapshot.hero.agentId;
  }

  if (!snapshot.active) {
    if (lifecycle.activityStartMs !== null && lifecycle.graceTimer === null) {
      clearPendingUpdate(lifecycle);
      lifecycle.graceTimer = setTimeout(() => {
        lifecycle.graceTimer = null;
        endActivity(lifecycle, serverId);
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
    const epoch = lifecycle.presenterEpoch;
    void enqueuePresenterTask(lifecycle, async () => {
      if (lifecycle.presenterEpoch !== epoch || lifecycle.activityStartMs === null) {
        return;
      }
      await presenter.start(snapshot);
    });
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
      endActivity(lifecycleRef.current, serverId);
      prevHeroAgentIdRef.current = null;
      return;
    }
    reconcileActivity(lifecycleRef.current, snapshot, serverId);
  }, [isConnected, serverId, snapshot]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    return () => {
      endActivity(lifecycle, serverId);
      prevHeroAgentIdRef.current = null;
    };
  }, [serverId]);
}
