import type { WorkspaceFileSelection } from "./types";

export interface WorkspaceFileDragSourceInput {
  enabled: boolean;
  disabled?: boolean;
  serverId?: string;
  workspaceId: string | null | undefined;
  path: string;
  selection?: WorkspaceFileSelection;
}
