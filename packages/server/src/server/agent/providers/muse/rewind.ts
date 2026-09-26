import type { MuseViewItem } from "./items.js";

export type MuseRewindPlan = { kind: "fresh" } | { kind: "fork"; lastTurnId: string };

/**
 * Resolve a Paseo rewind target (an MSP item id) to a `session/fork` cut
 * point: the last completed turn strictly before the target's turn. A target
 * in the first turn cannot fork to empty history, so it plans a fresh
 * session instead.
 */
export function resolveMuseRewindCutPoint(
  items: readonly MuseViewItem[],
  messageId: string,
): MuseRewindPlan {
  const targetId = messageId.trim();
  if (!targetId) {
    throw new Error("Muse rewind requires a message id");
  }
  const turnOrder: string[] = [];
  const seenTurns = new Set<string>();
  let found = false;
  let targetTurnId: string | null = null;
  for (const item of items) {
    const turnId = typeof item.turnId === "string" ? item.turnId : null;
    if (turnId && !seenTurns.has(turnId)) {
      seenTurns.add(turnId);
      turnOrder.push(turnId);
    }
    if (item.itemId === targetId) {
      found = true;
      targetTurnId = turnId;
    }
  }
  if (!found) {
    throw new Error(`Muse rewind target ${targetId} was not found in history`);
  }
  if (!targetTurnId) {
    throw new Error(`Muse rewind target ${targetId} is not part of a turn`);
  }
  const index = turnOrder.indexOf(targetTurnId);
  const lastTurnId = index > 0 ? turnOrder[index - 1] : undefined;
  if (!lastTurnId) {
    return { kind: "fresh" };
  }
  return { kind: "fork", lastTurnId };
}
