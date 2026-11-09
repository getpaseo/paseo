import type { ComponentProps } from "react";
import type { WorkspaceTabDragScope as WebScope } from "./workspace-tab-drag-scope.web";
export function WorkspaceTabDragScope({ children }: ComponentProps<typeof WebScope>) {
  return children;
}
