import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId, normalizeWorkspacePath } from "@/utils/workspace-identity";

interface PendingWorkspaceArchive {
  workspaceId: string;
  workspaceDirectory: string | null;
}

const pendingWorkspaceArchivesByServer = new Map<string, Map<string, PendingWorkspaceArchive>>();

function pendingArchiveKey(input: { serverId: string; workspaceId: string }): string {
  return `${input.serverId.trim()}::${input.workspaceId.trim()}`;
}

export function markWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory?: string | null;
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId) ?? new Map();
  archives.set(pendingArchiveKey({ serverId, workspaceId }), {
    workspaceId,
    workspaceDirectory: normalizeWorkspacePath(input.workspaceDirectory),
  });
  pendingWorkspaceArchivesByServer.set(serverId, archives);
}

export function clearWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return;
  }
  archives.delete(pendingArchiveKey({ serverId, workspaceId }));
  if (archives.size === 0) {
    pendingWorkspaceArchivesByServer.delete(serverId);
  }
}

export function isWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId?: string | null;
  workspaceDirectory?: string | null;
}): boolean {
  const serverId = input.serverId.trim();
  if (!serverId) {
    return false;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return false;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (workspaceId && archives.has(pendingArchiveKey({ serverId, workspaceId }))) {
    return true;
  }

  const workspaceDirectory = normalizeWorkspacePath(input.workspaceDirectory);
  if (!workspaceDirectory) {
    return false;
  }

  for (const archive of archives.values()) {
    if (archive.workspaceDirectory === workspaceDirectory) {
      return true;
    }
  }
  return false;
}

export function shouldSuppressWorkspaceForLocalArchive(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): boolean {
  return isWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    workspaceDirectory: input.workspace.workspaceDirectory,
  });
}
