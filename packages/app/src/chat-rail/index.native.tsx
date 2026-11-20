import type { ReactNode } from "react";

export interface ChatColumnRailSurfaceProps {
  serverId: string;
  children: ReactNode;
}

export interface ChatOutlineRailState {
  /** Whether the chat outline feature is enabled for this pane (independent of pane width). */
  readonly enabled: boolean;
  /** Left gutter inset currently reserved for the outline rail (`0` or `44` on web). */
  readonly inset: number;
}

const DISABLED_CHAT_OUTLINE_RAIL: ChatOutlineRailState = Object.freeze({
  enabled: false,
  inset: 0,
});

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

/** Chat outline state for this pane (always disabled with 0 inset on native). */
export function useChatOutlineRail(): ChatOutlineRailState {
  return DISABLED_CHAT_OUTLINE_RAIL;
}
