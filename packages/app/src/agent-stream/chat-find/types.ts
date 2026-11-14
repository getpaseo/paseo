import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";

export interface MountedMessageIds {
  has(messageId: string): boolean;
}
export interface ChatFindProps {
  agentId: string;
  serverId: string;
  epoch: string | null;
  items: StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  /** Called before a match moves the viewport, so other navigation can stand down. */
  onNavigate?(): void;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  messageId: string;
  children(renderFullContent: boolean): ReactNode;
}
