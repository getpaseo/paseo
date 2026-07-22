import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceTabDescriptor {
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
}
