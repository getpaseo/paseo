import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

/**
 * What this client last asked the host to do with a workspace, while the host catches up.
 *
 * - `archive`: the row is hidden; host upserts for it are dropped until its remove arrives.
 * - `undo`: the row is back; host removes for it are dropped until the undo response arrives.
 *
 * Each request gets its own intent. A request settles or checks only the intent it set, so a
 * late response for an earlier request never touches the intent of a newer one.
 */
export interface WorkspaceArchiveIntent {
  readonly kind: "archive" | "undo";
  /** Active agent IDs in the workspace when this client archived it, so undo only marks those agents as restoring. */
  readonly archivedAgentIds?: ReadonlySet<string>;
}

const intentsByServer = new Map<string, Map<string, WorkspaceArchiveIntent>>();
const intentListeners = new Set<() => void>();
const targetByIntent = new WeakMap<
  WorkspaceArchiveIntent,
  { serverId: string; workspaceId: string }
>();

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

function readIntent(input: WorkspaceIntentTarget): WorkspaceArchiveIntent | null {
  const target = resolveTarget(input);
  if (!target) return null;
  return intentsByServer.get(target.serverId)?.get(target.workspaceId) ?? null;
}

function setIntent(
  input: WorkspaceIntentTarget,
  kind: WorkspaceArchiveIntent["kind"],
  archivedAgentIds?: ReadonlySet<string>,
): WorkspaceArchiveIntent {
  const target = resolveTarget(input);
  const intent: WorkspaceArchiveIntent = archivedAgentIds ? { kind, archivedAgentIds } : { kind };
  if (!target) return intent;
  targetByIntent.set(intent, target);
  const intents = intentsByServer.get(target.serverId) ?? new Map();
  intents.set(target.workspaceId, intent);
  intentsByServer.set(target.serverId, intents);
  notifyIntentListeners();
  return intent;
}

function deleteIntent(target: { serverId: string; workspaceId: string }): void {
  const intents = intentsByServer.get(target.serverId);
  if (!intents) return;
  intents.delete(target.workspaceId);
  if (intents.size === 0) intentsByServer.delete(target.serverId);
  notifyIntentListeners();
}

function notifyIntentListeners(): void {
  for (const listener of intentListeners) listener();
}

/** Calls `listener` whenever any workspace's archive intent changes. */
export function subscribeWorkspaceArchiveIntents(listener: () => void): () => void {
  intentListeners.add(listener);
  return () => {
    intentListeners.delete(listener);
  };
}

function clearIntentOfKind(
  input: WorkspaceIntentTarget,
  kind: WorkspaceArchiveIntent["kind"],
): void {
  const target = resolveTarget(input);
  if (!target || readIntent(target)?.kind !== kind) return;
  deleteIntent(target);
}

/** True while `intent` is still the latest thing this client asked for its workspace. */
export function isWorkspaceArchiveIntentCurrent(intent: WorkspaceArchiveIntent): boolean {
  const target = targetByIntent.get(intent);
  return target !== undefined && readIntent(target) === intent;
}

/** The request behind `intent` settled. A newer request's intent stays in place. */
export function settleWorkspaceArchiveIntent(intent: WorkspaceArchiveIntent): void {
  const target = targetByIntent.get(intent);
  if (target && readIntent(target) === intent) deleteIntent(target);
}

export function markWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): WorkspaceArchiveIntent {
  return setIntent(input, "archive");
}

/** The host removed the workspace, which settles whichever archive this client has pending. */
export function clearWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  clearIntentOfKind(input, "archive");
}

export function isWorkspaceArchivePending(input: WorkspaceIntentTarget): boolean {
  return readIntent(input)?.kind === "archive";
}

export function markWorkspaceArchiveUndoPending(input: {
  serverId: string;
  workspaceId: string;
  archivedAgentIds?: ReadonlySet<string>;
}): WorkspaceArchiveIntent {
  return setIntent(input, "undo", input.archivedAgentIds);
}

export function isWorkspaceArchiveUndoPending(input: WorkspaceIntentTarget): boolean {
  return readIntent(input)?.kind === "undo";
}

/** Returns the active agent IDs captured by a pending workspace undo, if any. */
export function getWorkspaceArchiveUndoArchivedAgentIds(
  input: WorkspaceIntentTarget,
): ReadonlySet<string> | null {
  const intent = readIntent(input);
  if (intent?.kind !== "undo") return null;
  return intent.archivedAgentIds ?? null;
}

/**
 * True while this client's workspace undo is pending and `agentId` was active in that
 * workspace when archived. Agents that were already archived before the workspace archive
 * return false so they are not mislabeled as unarchiving.
 */
export function isWorkspaceArchiveUndoRestoringAgent(input: {
  serverId: string;
  workspaceId?: string | null;
  agentId?: string | null;
}): boolean {
  const intent = readIntent(input);
  if (intent?.kind !== "undo") return false;
  const agentId = input.agentId?.trim();
  if (!agentId) return false;
  if (!intent.archivedAgentIds) return false;
  return intent.archivedAgentIds.has(agentId);
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
