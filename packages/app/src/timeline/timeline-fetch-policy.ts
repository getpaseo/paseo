// Count is projected timeline items, not delta chunks. The daemon's `selectTimelineWindowByProjectedLimit` interprets this against canonical entries: `assistant_merge`, `reasoning_merge`, and `tool_lifecycle`. Do not confuse this with raw stream deltas.
export const TIMELINE_FETCH_PAGE_SIZE = 100;
