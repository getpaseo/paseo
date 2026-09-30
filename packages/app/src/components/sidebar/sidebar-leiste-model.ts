import type { InboxItem } from "@/leitstand/inbox-model";

/** The sidebar keeps its session list in view; the rest of the inbox is one press away. */
export const SIDEBAR_INBOX_LIMIT = 5;

export interface SidebarInboxProjection {
  rows: InboxItem[];
  /** Items past the limit, reachable on the Leitstand. */
  hiddenCount: number;
}

/**
 * What the sidebar's "Needs you" section shows, or null when it stays out of the way: nothing
 * needs you, or the Leitstand is open and already shows the full inbox.
 */
export function projectSidebarInbox(input: {
  items: readonly InboxItem[];
  isLeitstandOpen: boolean;
  limit?: number;
}): SidebarInboxProjection | null {
  if (input.isLeitstandOpen || input.items.length === 0) return null;
  const limit = input.limit ?? SIDEBAR_INBOX_LIMIT;
  return {
    rows: input.items.slice(0, limit),
    hiddenCount: Math.max(0, input.items.length - limit),
  };
}
