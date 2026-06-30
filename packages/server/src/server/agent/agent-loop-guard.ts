import type { ToolCallTimelineItem } from "./agent-sdk-types.js";

/**
 * Circuit breaker for stuck agents that repeat the same unproductive tool call.
 *
 * The model's tool-call loop runs inside the provider process (OpenCode server,
 * Codex app-server, Claude CLI, ACP agent); Paseo only observes it over the
 * provider event stream. When a model gets wedged — e.g. re-issuing a shell
 * command that always fails — nothing in the provider stops it, so a single turn
 * can burn many minutes and hundreds of identical tool calls while the UI shows
 * an indistinguishable-from-hung "running…" state.
 *
 * This guard is provider-agnostic: it observes the shared `tool_call` timeline
 * items every provider funnels through `AgentManager.recordAndDispatchTimelineItem`
 * and trips when the same *unproductive* tool call repeats N times in a row within
 * one turn. The caller is expected to cancel the turn and surface a clear message.
 *
 * "Unproductive" is repetition + a non-success outcome, NOT just `status: "failed"`.
 * A failing shell command (e.g. `rtk lint` with no such subcommand) usually arrives
 * as `status: "completed"` with a non-zero `exitCode` — the tool ran fine, the
 * command failed — so keying on `failed` alone would miss the most common loop.
 */

export const DEFAULT_LOOP_GUARD_THRESHOLD = 12;

export interface LoopGuardState {
  turnId: string | undefined;
  signature: string | null;
  unproductiveCount: number;
  tripped: boolean;
  countedCallIds: Set<string>;
}

export type LoopGuardOutcome =
  | { tripped: false }
  | { tripped: true; signature: string; count: number };

export function createLoopGuardState(): LoopGuardState {
  return {
    turnId: undefined,
    signature: null,
    unproductiveCount: 0,
    tripped: false,
    countedCallIds: new Set(),
  };
}

/**
 * Stable identity for a tool call, ignoring volatile fields (callId, output,
 * timing). Two calls with the same signature are "the same action".
 */
export function toolCallSignature(item: ToolCallTimelineItem): string {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return `shell:${detail.command}`;
    case "read":
      return `read:${detail.filePath}`;
    case "edit":
      return `edit:${detail.filePath}`;
    case "write":
      return `write:${detail.filePath}`;
    case "search":
      return `search:${detail.toolName ?? "search"}:${detail.query}`;
    case "fetch":
      return `fetch:${detail.url}`;
    default:
      return `${item.name}:${detail.type}`;
  }
}

function isUnproductive(item: ToolCallTimelineItem): boolean {
  if (item.status === "failed") {
    return true;
  }
  if (item.status === "completed" && item.detail.type === "shell") {
    const exitCode = item.detail.exitCode;
    return typeof exitCode === "number" && exitCode !== 0;
  }
  return false;
}

/**
 * Observe a terminal `tool_call` timeline item and mutate `state` accordingly.
 * Returns `{ tripped: true, ... }` exactly once per stuck streak per turn — the
 * caller should react (cancel the turn) and not be called again until the streak
 * resets (new turn, productive call, or a different action).
 */
export function observeToolCall(
  state: LoopGuardState,
  item: ToolCallTimelineItem,
  turnId: string | undefined,
  threshold: number = DEFAULT_LOOP_GUARD_THRESHOLD,
): LoopGuardOutcome {
  // Only terminal outcomes carry signal. Ignore "running" / "canceled".
  if (item.status !== "completed" && item.status !== "failed") {
    return { tripped: false };
  }

  // A new turn resets the streak entirely.
  if (turnId !== state.turnId) {
    state.turnId = turnId;
    state.signature = null;
    state.unproductiveCount = 0;
    state.tripped = false;
    state.countedCallIds.clear();
  }

  // Already tripped this turn — don't fire repeatedly.
  if (state.tripped) {
    return { tripped: false };
  }

  const unproductive = isUnproductive(item);
  const signature = toolCallSignature(item);

  // A productive call, or a different action, breaks the streak.
  if (!unproductive || signature !== state.signature) {
    state.signature = unproductive ? signature : null;
    state.unproductiveCount = unproductive ? 1 : 0;
    state.countedCallIds.clear();
    if (unproductive) {
      state.countedCallIds.add(item.callId);
    }
    return { tripped: false };
  }

  // Same unproductive action again. Dedupe status transitions of one call.
  if (state.countedCallIds.has(item.callId)) {
    return { tripped: false };
  }
  state.countedCallIds.add(item.callId);
  state.unproductiveCount += 1;

  if (state.unproductiveCount >= threshold) {
    state.tripped = true;
    return { tripped: true, signature, count: state.unproductiveCount };
  }
  return { tripped: false };
}
