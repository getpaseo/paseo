import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";

export interface ChatFindProps {
  agentId: string;
  serverId: string;
  epoch: string | null;
  items: StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedItem(itemId: string): boolean;
  visibleItemIds: ReadonlySet<string>;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  itemId: string;
  children(renderFullContent: boolean): ReactNode;
}
