import type { MessageTrailItem } from "./message-trail-items";

export interface MessageTrailTocProps {
  items: MessageTrailItem[];
  onJumpToMessage: (id: string) => void;
}

// Base/native fallback: the floating table-of-contents is web-only for now (it stands in
// for the tick rail when the pane is too narrow to show it). Metro picks the `.web` file
// on web; native renders nothing.
export function MessageTrailToc(_props: MessageTrailTocProps): null {
  return null;
}
