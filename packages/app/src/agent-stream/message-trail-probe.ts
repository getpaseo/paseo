import type { TrailAnchorSnapshot } from "./message-trail-anchor";

// The "current reading position" line for the message-trail: the last user-message row
// whose top edge sits at or above this fraction of the viewport from the top.
export const TRAIL_CURRENT_TOP_FRACTION = 0.25;

export function computeTrailAnchor(input: {
  ids: readonly string[];
  scrollTop: number;
  clientHeight: number;
  isAtBottom: boolean;
  resolveOffset: (id: string) => number | null;
}): TrailAnchorSnapshot {
  const { ids, scrollTop, clientHeight, isAtBottom, resolveOffset } = input;
  if (ids.length === 0) {
    return { currentId: null };
  }

  const currentLine = scrollTop + clientHeight * TRAIL_CURRENT_TOP_FRACTION;

  let currentId: string | null = null;
  for (const id of ids) {
    const top = resolveOffset(id);
    if (top === null) {
      continue;
    }
    // currentId: last (lowest-in-order) user row whose top is at/above the reading line.
    if (top <= currentLine) {
      currentId = id;
    }
  }

  // At the very bottom there's nothing left to scroll into, so the top-25%-line rule can
  // never reach the final message if its own exchange is shorter than ~75% of the
  // viewport (a short last reply) — the second-to-last message would otherwise stay
  // "current" forever once you're at the end. Snap to the last message instead.
  if (isAtBottom) {
    currentId = ids[ids.length - 1] ?? currentId;
  }

  return { currentId };
}
