/**
 * The share a drag leaves the first pane of a split. Short content stops the separator at the
 * content's bottom, so a drag that ends there or below saves what was drawn and keeps any larger
 * share the pane already had. The separator then neither jumps to the pointer nor stays pinned
 * at the old content height when the content grows.
 */
export function resolveDraggedShare(
  pointerShare: number,
  currentShare: number,
  contentShare: number,
) {
  if (pointerShare < contentShare) return pointerShare;
  return Math.max(currentShare, contentShare);
}
