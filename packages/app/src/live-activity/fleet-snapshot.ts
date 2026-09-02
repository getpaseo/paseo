/**
 * Pure fleet-mode selector for the iOS Live Activity feature. Types and priority/hysteresis
 * rules follow the fixed fleet-mode contract; this module has no React and no native imports.
 */

export type FleetAgentState = "running" | "needs_you" | "error";

export interface FleetHero {
  agentId: string;
  serverId: string;
  title: string;
  state: FleetAgentState;
  /** set when needs_you is due to a pending permission request */
  permissionToolName?: string;
  /** first line of the permission command/input, truncated to 80 chars */
  permissionDetail?: string;
  /** id of the pending permission request driving needs_you, when applicable */
  permissionRequestId?: string;
  /** provider action link-worthy as the primary Live Activity action, per selection rules */
  permissionPrimaryAction?: { id: string; label: string };
  /** one-line current phase, e.g. tool name; omit rather than fabricate */
  phase?: string;
  todoDone?: number;
  todoTotal?: number;
  /** epoch ms when the hero entered its current state; drives client-side timers */
  sinceMs: number;
}

export interface FleetSnapshot {
  /** true iff any agent is running, needs_you, or error */
  active: boolean;
  hero: FleetHero | null;
  needsYouCount: number; // includes error agents
  runningCount: number;
  /** epoch ms start of the longest-running agent, when runningCount > 0 */
  longestRunningSinceMs?: number;
}

export interface FleetPendingPermission {
  requestId: string;
  toolName: string;
  detail?: string;
  sinceMs: number;
  /** provider-selected primary action, per selection rules; absent means no primary shortcut */
  primaryAction?: { id: string; label: string };
}

export interface FleetAgentInput {
  agentId: string;
  serverId: string;
  title: string;
  running: boolean;
  error: boolean;
  pendingPermission?: FleetPendingPermission;
  /** set when agent requires attention (non-permission) */
  needsAttentionSinceMs?: number;
  /** set when running */
  runningSinceMs?: number;
  /** set when status is error; from attentionTimestamp, lastActivityAt, or updatedAt */
  errorSinceMs?: number;
  phase?: string;
  todoDone?: number;
  todoTotal?: number;
}

type FleetPriorityClass = 1 | 2 | 3 | 4;

interface ActiveFleetAgent {
  input: FleetAgentInput;
  index: number;
  priorityClass: FleetPriorityClass;
  tiebreakMs: number;
}

function needsYou(input: FleetAgentInput): boolean {
  return (
    input.pendingPermission !== undefined ||
    input.needsAttentionSinceMs !== undefined ||
    input.error
  );
}

/**
 * Classifies one agent into its hero-selection priority class, or `null` when the agent is
 * not part of the active set. Class 2 (error) has no timestamp on the input, so its tiebreak
 * falls back to input order for determinism.
 */
function classifyActiveAgent(input: FleetAgentInput, index: number): ActiveFleetAgent | null {
  if (input.pendingPermission !== undefined) {
    return { input, index, priorityClass: 1, tiebreakMs: input.pendingPermission.sinceMs };
  }
  if (input.error) {
    return { input, index, priorityClass: 2, tiebreakMs: index };
  }
  if (input.needsAttentionSinceMs !== undefined) {
    return { input, index, priorityClass: 3, tiebreakMs: input.needsAttentionSinceMs };
  }
  if (input.running) {
    return { input, index, priorityClass: 4, tiebreakMs: input.runningSinceMs ?? index };
  }
  return null;
}

function compareActiveFleetAgents(a: ActiveFleetAgent, b: ActiveFleetAgent): number {
  if (a.priorityClass !== b.priorityClass) {
    return a.priorityClass - b.priorityClass;
  }
  if (a.tiebreakMs !== b.tiebreakMs) {
    return a.tiebreakMs - b.tiebreakMs;
  }
  return a.index - b.index;
}

function truncatePermissionDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const firstLine = detail.split("\n")[0] ?? "";
  return firstLine.slice(0, 80);
}

function heroState(input: FleetAgentInput): FleetAgentState {
  if (input.pendingPermission !== undefined) {
    return "needs_you";
  }
  if (input.error) {
    return "error";
  }
  if (input.needsAttentionSinceMs !== undefined) {
    return "needs_you";
  }
  return "running";
}

function heroSinceMs(input: FleetAgentInput): number {
  if (input.pendingPermission !== undefined) {
    return input.pendingPermission.sinceMs;
  }
  if (input.error) {
    return input.errorSinceMs ?? input.needsAttentionSinceMs ?? input.runningSinceMs ?? 0;
  }
  if (input.needsAttentionSinceMs !== undefined) {
    return input.needsAttentionSinceMs;
  }
  return input.runningSinceMs ?? 0;
}

function buildHero(input: FleetAgentInput): FleetHero {
  return {
    agentId: input.agentId,
    serverId: input.serverId,
    title: input.title,
    state: heroState(input),
    permissionToolName: input.pendingPermission?.toolName,
    permissionDetail: truncatePermissionDetail(input.pendingPermission?.detail),
    permissionRequestId: input.pendingPermission?.requestId,
    permissionPrimaryAction: input.pendingPermission?.primaryAction,
    phase: input.phase,
    todoDone: input.todoDone,
    todoTotal: input.todoTotal,
    sinceMs: heroSinceMs(input),
  };
}

/** Longest-running start time among agents counted in `runningCount`, i.e. plain running agents. */
function longestRunningSinceMs(agents: readonly FleetAgentInput[]): number | undefined {
  return agents.reduce<number | undefined>((longest, input) => {
    if (!input.running || needsYou(input) || input.runningSinceMs === undefined) {
      return longest;
    }
    return longest === undefined || input.runningSinceMs < longest ? input.runningSinceMs : longest;
  }, undefined);
}

/**
 * Selects the fleet hero and headline counts from raw agent state. Pure and deterministic:
 * every timestamp comes from `agents`, none from the wall clock.
 *
 * Hysteresis: `prevHeroAgentId` keeps its hero unless it left the active set, or a candidate
 * reaches a strictly higher priority class. Same-class ties or better same-class timestamps
 * never swap the hero.
 */
export function selectFleetSnapshot(
  agents: readonly FleetAgentInput[],
  prevHeroAgentId: string | null,
): FleetSnapshot {
  const activeAgents = agents
    .map((input, index) => classifyActiveAgent(input, index))
    .filter((entry): entry is ActiveFleetAgent => entry !== null);

  if (activeAgents.length === 0) {
    return { active: false, hero: null, needsYouCount: 0, runningCount: 0 };
  }

  const bestCandidate = activeAgents.reduce((best, candidate) =>
    compareActiveFleetAgents(candidate, best) < 0 ? candidate : best,
  );
  const currentHero = activeAgents.find((candidate) => candidate.input.agentId === prevHeroAgentId);
  const hero =
    currentHero !== undefined && bestCandidate.priorityClass >= currentHero.priorityClass
      ? currentHero
      : bestCandidate;

  return {
    active: true,
    hero: buildHero(hero.input),
    needsYouCount: agents.filter(needsYou).length,
    runningCount: agents.filter((input) => input.running && !needsYou(input)).length,
    longestRunningSinceMs: longestRunningSinceMs(agents),
  };
}
