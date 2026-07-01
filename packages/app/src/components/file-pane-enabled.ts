/**
 * Whether `FilePane` should read its file right now.
 *
 * The read is gated on visibility so a revisited tab refetches instead of showing
 * the frozen first-load snapshot (#445): React Query refetches on the
 * disabled→enabled transition (stale-gated by the query's staleTime). The file is
 * read only when there is something to read AND the pane can actually show it —
 * the tab is the active one (not a hidden, mounted-but-offscreen tab) and the
 * whole app is in the foreground.
 */
export function isFileQueryEnabled(input: {
  hasReadTarget: boolean;
  isTabActive: boolean;
  isAppVisible: boolean;
}): boolean {
  return input.hasReadTarget && input.isTabActive && input.isAppVisible;
}
