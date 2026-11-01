import type { GoalEvent } from "./types.js";

/**
 * Milliseconds the goal ran, as of `untilMs`, since it was created or a retry last restarted
 * its time limit fresh. It runs from goal.created, a reopen or goal.resumed until it fails,
 * is paused, cancelled or completed; time paused or failed does not count. Planning and
 * waiting for plan approval count as running, as they do for the wall-clock limit timer.
 * Time any agent of the goal spent waiting for a person's answer (wait.started to its end) does
 * not count either, as the time limit leaves it out. An event whose time does not parse is
 * skipped.
 */
export function goalActiveMs(events: readonly GoalEvent[], untilMs: number): number {
  let activeMs = 0;
  let since: number | null = null;
  let state: RunState = { ended: false, paused: false, waiting: new Map() };
  for (const event of events) {
    const at = Date.parse(event.at);
    const next = Number.isNaN(at) ? null : stateAfter(event, state);
    if (!next) continue;
    const wasRunning = since !== null;
    const { fresh, ...nextState } = next;
    if (fresh) {
      activeMs = 0;
      // A goal still paused does not start running until it is resumed.
      if (wasRunning) since = at;
    }
    state = nextState;
    const running = !state.ended && !state.paused && state.waiting.size === 0;
    if (wasRunning && !running && since !== null) {
      activeMs += Math.max(0, at - since);
      since = null;
    } else if (!wasRunning && running) {
      since = at;
    }
  }
  return since === null ? activeMs : activeMs + Math.max(0, untilMs - since);
}

interface RunState {
  ended: boolean;
  paused: boolean;
  /** Agents waiting for a person's answer, with the run each waits in, if any. */
  waiting: ReadonlyMap<string, string | undefined>;
}

/** The waits left open once `isClosed` closes some; the same map when none closes. */
function closeWaits(
  waiting: RunState["waiting"],
  isClosed: (agentId: string, runId: string | undefined) => boolean,
): RunState["waiting"] {
  if (![...waiting].some(([agentId, runId]) => isClosed(agentId, runId))) return waiting;
  return new Map([...waiting].filter(([agentId, runId]) => !isClosed(agentId, runId)));
}

/** How an event changes whether the goal runs, or null when it does not. */
function stateAfter(event: GoalEvent, state: RunState): (RunState & { fresh?: boolean }) | null {
  switch (event.type) {
    case "goal.created":
      return { ...state, ended: false };
    case "goal.retried":
    case "goal.reopened":
    case "changeset.integration_retried":
      return { ...state, ended: false, fresh: event.timeMode === "fresh" };
    // The goal stays failed while a recovery decides; it runs again once the recovery applies.
    case "recovery.resolved":
      return event.outcome === "applied"
        ? { ...state, ended: false, fresh: event.timeMode === "fresh" }
        : null;
    case "goal.resumed":
      return { ...state, paused: false };
    case "goal.paused":
      return { ...state, paused: true };
    case "goal.failed":
    case "goal.cancelled":
    case "goal.completed":
    case "goal.accepted":
      return { ...state, ended: true, waiting: new Map() };
    case "wait.started":
      return { ...state, waiting: new Map([...state.waiting, [event.agentId, event.runId]]) };
    case "wait.ended":
      return {
        ...state,
        waiting: closeWaits(state.waiting, (agentId) => agentId === event.agentId),
      };
    // run.finished names only the run, so its wait is found by the run id wait.started recorded.
    case "run.finished":
      return {
        ...state,
        waiting: closeWaits(state.waiting, (_agentId, runId) => runId === event.runId),
      };
    default:
      return null;
  }
}
