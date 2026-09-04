import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceTabDescriptor {
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
  state?: import("@getpaseo/protocol/agent-types").JsonValue;
  /** Mirrors `WorkspaceTab.preview` so the tab strip can render the slot as provisional. */
  preview?: boolean;
}
