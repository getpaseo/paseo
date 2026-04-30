import type { WorkspaceDescriptor } from "@/stores/session-store";

export function shouldSuppressWorkspaceUpsertForLocalArchive(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  isArchivePending: (params: { serverId: string; cwd: string }) => boolean;
}): boolean {
  return (
    input.workspace.archivingAt !== null &&
    input.isArchivePending({
      serverId: input.serverId,
      cwd: input.workspace.workspaceDirectory,
    })
  );
}
