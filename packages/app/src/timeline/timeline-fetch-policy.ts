// Count is projected timeline items, not delta chunks. Fetch responses never return
// tool lifecycle deltas; `sourceSeqRanges` maps projected items back to source seqs.
export const TIMELINE_FETCH_PAGE_SIZE = 100;
