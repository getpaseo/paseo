import type { ReactNode } from "react";
import type { WorkspaceViewportWidthStore } from "../workspace-viewport-width";
export interface ExplorerFrameProps {
  children: ReactNode;
  presentation: "overlay" | "dock";
  persistenceKey: string;
  viewportWidth: WorkspaceViewportWidthStore;
  isOpen: boolean;
  isWorkspaceActive: boolean;
  surfaceColor?: string;
}
