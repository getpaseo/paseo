/**
 * Pure resolution of "where should navigating to this matched item actually
 * land" — kept free of React/RN so it's independently testable.
 *
 * A matched StreamItem id is not always its own reachable row:
 *  - Tool calls compacted into a collapsed run (see tool-calls/grouping.ts)
 *    don't render their own row while collapsed — only the group's host row
 *    does. The reachable target is that host id, and the group must be
 *    expanded for the match to actually become visible. This is checked
 *    FIRST: a trailing tool-call group can start in retained history and
 *    still contain a newer live-head call, so a match can be both
 *    live-head and grouped — the group must win, or the match is left
 *    unreachable (bottom doesn't expand the group).
 *  - Live-head items (still streaming, not yet part of persisted history)
 *    that are NOT part of any group aren't part of the rendered history rows
 *    at all; the nearest reachable target is the bottom of the stream.
 */
export type TimelineSearchScrollTarget =
  | { kind: "bottom" }
  | { kind: "group"; groupId: string }
  | { kind: "item"; itemId: string };

export interface ResolveTimelineSearchScrollTargetInput {
  itemId: string;
  isLiveHeadItem: (itemId: string) => boolean;
  findGroupIdForItem: (itemId: string) => string | null;
}

export function resolveTimelineSearchScrollTarget(
  input: ResolveTimelineSearchScrollTargetInput,
): TimelineSearchScrollTarget {
  const groupId = input.findGroupIdForItem(input.itemId);
  if (groupId) {
    return { kind: "group", groupId };
  }
  if (input.isLiveHeadItem(input.itemId)) {
    return { kind: "bottom" };
  }
  return { kind: "item", itemId: input.itemId };
}
