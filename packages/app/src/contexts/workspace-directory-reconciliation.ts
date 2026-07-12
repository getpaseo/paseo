import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";
import { shouldSuppressWorkspaceForLocalArchive } from "./session-workspace-upserts";

type WorkspaceDelta = Extract<SessionOutboundMessage, { type: "workspace_update" }>["payload"];

export function reconcileWorkspaceDirectory(input: {
  serverId: string;
  snapshot: ReadonlyMap<string, WorkspaceDescriptor>;
  deltas: readonly WorkspaceDelta[];
}): Map<string, WorkspaceDescriptor> {
  const workspaces = new Map(input.snapshot);
  for (const delta of input.deltas) {
    if (delta.kind === "remove") {
      workspaces.delete(delta.id);
    } else {
      const workspace = normalizeWorkspaceDescriptor(delta.workspace);
      if (shouldSuppressWorkspaceForLocalArchive({ serverId: input.serverId, workspace })) {
        workspaces.delete(workspace.id);
      } else {
        workspaces.set(workspace.id, workspace);
      }
    }
  }
  return workspaces;
}
