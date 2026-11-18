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
