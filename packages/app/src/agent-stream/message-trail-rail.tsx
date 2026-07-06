import type { MessageTrailItem } from "./message-trail-items";
import type { TrailAnchorStore } from "./message-trail-anchor";

export interface MessageTrailRailProps {
  items: MessageTrailItem[];
  anchor: TrailAnchorStore;
  onJumpToMessage: (id: string) => void;
  onFitChange: (fits: boolean) => void;
}

// Native/fallback: the message-trail rail is a web/desktop-only affordance built on
// raw DOM (pointer coalescing, imperative per-tick style writes). Metro resolves the
// `.web.tsx` sibling on web; native gets this null component so the tree is unaffected.
export function MessageTrailRail(_props: MessageTrailRailProps): null {
  return null;
}
