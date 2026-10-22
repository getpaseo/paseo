import { createContext, useContext } from "react";

/** What the host tells `WorkspaceRowBadge` about the row item it renders in. */
export interface WorkspaceRowItemFrame {
  title: string;
  testID: string;
  /** Something is drawn before this item on the line, so the badge leads with a separator. */
  separated: boolean;
}

export const WorkspaceRowItemFrameContext = createContext<WorkspaceRowItemFrame | null>(null);

export function useWorkspaceRowItemFrame(componentName: string): WorkspaceRowItemFrame {
  const frame = useContext(WorkspaceRowItemFrameContext);
  if (!frame) throw new Error(`${componentName} must render inside a workspace row item`);
  return frame;
}
