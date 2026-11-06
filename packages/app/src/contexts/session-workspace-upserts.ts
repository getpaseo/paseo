import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

/**
 * What this client last asked the host to do with a workspace, while the host catches up.
 *
 * - `archive`: the row is hidden; host upserts for it are dropped until its remove arrives.
 * - `undo`: the row is back; host removes for it are dropped until the undo response arrives.
 *
 * Only the request that set an intent may clear it, so a late response for an earlier
 * request never clears the intent of a newer one.
 */
type LocalWorkspaceArchiveIntent = "archive" | "undo";

const intentsByServer = new Map<string, Map<string, LocalWorkspaceArchiveIntent>>();

interface WorkspaceIntentTarget {
  serverId: string;
  workspaceId?: string | null;
}

function resolveTarget(
  input: WorkspaceIntentTarget,
): { serverId: string; workspaceId: string } | null {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) return null;
  return { serverId, workspaceId };
}

function readIntent(input: WorkspaceIntentTarget): LocalWorkspaceArchiveIntent | null {
  const target = resolveTarget(input);
  if (!target) return null;
  return intentsByServer.get(target.serverId)?.get(target.workspaceId) ?? null;
}

function setIntent(input: WorkspaceIntentTarget, intent: LocalWorkspaceArchiveIntent): void {
  const target = resolveTarget(input);
  if (!target) return;
  const intents = intentsByServer.get(target.serverId) ?? new Map();
  intents.set(target.workspaceId, intent);
  intentsByServer.set(target.serverId, intents);
}

function clearIntent(input: WorkspaceIntentTarget, intent: LocalWorkspaceArchiveIntent): void {
  const target = resolveTarget(input);
  if (!target) return;
  const intents = intentsByServer.get(target.serverId);
  if (intents?.get(target.workspaceId) !== intent) return;
  intents.delete(target.workspaceId);
  if (intents.size === 0) intentsByServer.delete(target.serverId);
}

export function markWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  setIntent(input, "archive");
}

export function clearWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  clearIntent(input, "archive");
}

export function isWorkspaceArchivePending(input: WorkspaceIntentTarget): boolean {
  return readIntent(input) === "archive";
}

export function markWorkspaceArchiveUndoPending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  setIntent(input, "undo");
}

export function clearWorkspaceArchiveUndoPending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  clearIntent(input, "undo");
}

export function isWorkspaceArchiveUndoPending(input: WorkspaceIntentTarget): boolean {
  return readIntent(input) === "undo";
}

export function shouldSuppressWorkspaceForLocalArchive(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): boolean {
  return isWorkspaceArchivePending({ serverId: input.serverId, workspaceId: input.workspace.id });
}

export function shouldSuppressWorkspaceRemovalForLocalUndo(input: {
  serverId: string;
  workspaceId: string;
}): boolean {
  return isWorkspaceArchiveUndoPending(input);
}
