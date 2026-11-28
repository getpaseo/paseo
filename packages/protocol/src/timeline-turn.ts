/** Canonical run identity wins over trigger-shaped rows steered into that run. */
export function continuesTimelineTurn(
  previousTurnId: string | undefined,
  nextTurnId: string | undefined,
  nextIsTrigger: boolean,
): boolean {
  if (previousTurnId !== undefined && nextTurnId !== undefined) {
    return previousTurnId === nextTurnId;
  }
  // Missing IDs cannot recover historical batching or steering. Each visible
  // trigger deterministically starts a turn in both paging and presentation.
  return !nextIsTrigger;
}

/** Tool calls the daemon projects from prompts it delivered: schedules, messages, notifications. */
const DELIVERED_PROMPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "heartbeat",
  "agent_message",
  "agent_finished",
  "agent_errored",
  "agent_needs_permission",
  "agent_closed",
]);

export function isTimelineTurnTrigger(item: { type: string; name?: string }): boolean {
  return (
    item.type === "user_message" ||
    (item.type === "tool_call" &&
      item.name !== undefined &&
      DELIVERED_PROMPT_TOOL_NAMES.has(item.name))
  );
}
