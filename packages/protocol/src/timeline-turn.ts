/**
 * Canonical run identity wins over trigger-shaped rows steered into that run.
 *
 * A row with no turn ID next to a row with one belongs to no turn: the daemon writes rows between
 * turns, such as a background task's notification, without an ID. It never continues a turn, so
 * it cannot join the turn before it to the turn after it.
 */
export function continuesTimelineTurn(
  previousTurnId: string | undefined,
  nextTurnId: string | undefined,
  nextIsTrigger: boolean,
): boolean {
  if (previousTurnId !== undefined || nextTurnId !== undefined) {
    return previousTurnId === nextTurnId;
  }
  // History without IDs cannot recover batching or steering. Each visible
  // trigger deterministically starts a turn in both paging and presentation.
  return !nextIsTrigger;
}

export function isTimelineTurnTrigger(item: {
  type: string;
  name?: string;
  agentMessage?: unknown;
}): boolean {
  return (
    item.type === "user_message" ||
    (item.type === "tool_call" && (item.agentMessage !== undefined || item.name === "heartbeat"))
  );
}
