import { createContext, useContext } from "react";
import type { RowBadgeLine } from "./line";

/** What the host tells `WorkspaceRowBadge` about the row item it renders in. */
export interface WorkspaceRowBadgeItemFrame {
  title: string;
  testID: string;
  /** The row drew items of its own before the plugin line, so the first badge leads with a separator. */
  leading: boolean;
  /** This item's place among the row's plugin items. */
  position: number;
  line: RowBadgeLine;
}

export const WorkspaceRowBadgeItemFrameContext = createContext<WorkspaceRowBadgeItemFrame | null>(
  null,
);

export function useWorkspaceRowBadgeItemFrame(componentName: string): WorkspaceRowBadgeItemFrame {
  const frame = useContext(WorkspaceRowBadgeItemFrameContext);
  if (!frame) throw new Error(`${componentName} must render inside a workspace row badge item`);
  return frame;
}
