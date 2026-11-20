import type { ReactNode } from "react";

export interface ChatColumnRailSurfaceProps {
  serverId: string;
  children: ReactNode;
}

/**
 * Marker for chat surfaces (composer, track bar, callouts) that share the pane's
 * horizontal column rail. On web, an active `ChatColumnRailSurface` applies the
 * pane's outline-aware gutters via CSS custom properties without re-rendering
 * children. Native never reserves an outline gutter, so this is undefined.
 */
export const CHAT_COLUMN_RAIL_DATASET: Record<string, string> | undefined = undefined;

/**
 * Native pass-through: the chat outline is a wide-layout web affordance, so native
 * renders no wrapper view, registers no subscriptions, and reserves no outline inset.
 */
export function ChatColumnRailSurface({ children }: ChatColumnRailSurfaceProps) {
  return children;
}

/** Current left gutter inset reserved for the chat outline in this pane (always 0 on native). */
export function useChatOutlineInset(): number {
  return 0;
}
