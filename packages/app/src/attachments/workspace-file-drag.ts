import type { WorkspaceFileComposerAttachment } from "./types";
import { isWorkspaceFileComposerAttachment } from "./workspace-file";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-paseo-workspace-file+json";

export interface WorkspaceFileDragPayload {
  version: 1;
  serverId: string;
  workspaceId: string;
  attachment: WorkspaceFileComposerAttachment;
}

export function serializeWorkspaceFileDragPayload(payload: WorkspaceFileDragPayload): string {
  return JSON.stringify(payload);
}

export function parseWorkspaceFileDragPayload(serialized: string): WorkspaceFileDragPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.serverId !== "string" ||
    record.serverId.length === 0 ||
    typeof record.workspaceId !== "string" ||
    record.workspaceId.length === 0 ||
    !isWorkspaceFileComposerAttachment(record.attachment)
  ) {
    return null;
  }
  return {
    version: 1,
    serverId: record.serverId,
    workspaceId: record.workspaceId,
    attachment: record.attachment,
  };
}

export function resolveWorkspaceFileDrop(input: {
  payload: WorkspaceFileDragPayload;
  serverId: string;
  workspaceId: string;
}): WorkspaceFileComposerAttachment | null {
  return input.payload.serverId === input.serverId &&
    input.payload.workspaceId === input.workspaceId
    ? input.payload.attachment
    : null;
}
