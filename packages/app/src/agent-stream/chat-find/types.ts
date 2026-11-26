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
  /** The sequence number of the latest rewind applied to this history, if any. */
  rewindSeq: number | null;
  items: StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  messageId: string;
  children(renderFullContent: boolean): ReactNode;
}
