import type { UserComposerAttachment } from "@/attachments/types";
import { getWorkspaceFileAttachmentKey } from "@/attachments/workspace-file";

export const PROMPT_STASH_STORE_VERSION = 1;

/** Per-provider cap; the oldest entry is evicted when a stash overflows. */
export const MAX_STASH_ENTRIES_PER_QUEUE = 20;

/**
 * Queue bucket for prompts stashed while no provider is selected.
 * Provider-derived keys are prefixed (see `buildPromptStashScopeKey`), so this
 * sentinel can never collide with a provider literally named `__none__`.
 */
export const PROMPT_STASH_UNSCOPED_KEY = "__none__";
const PROVIDER_SCOPE_PREFIX = "provider:";

export interface PromptStashEntry {
  id: string;
  createdAt: number;
  text: string;
  attachments: UserComposerAttachment[];
  provider: string | null;
}

export type PromptStashQueues = Record<string, PromptStashEntry[]>;

/** Maps the composer's active provider to a stash queue bucket. */
export function buildPromptStashScopeKey(provider: string | null | undefined): string {
  return provider ? `${PROVIDER_SCOPE_PREFIX}${provider}` : PROMPT_STASH_UNSCOPED_KEY;
}

/**
 * Reads a queue without inheriting from `Object.prototype`: queue keys are
 * rehydrated from storage as plain strings, so a corrupted payload could carry
 * a literal `__proto__` key that must not resolve to the prototype chain.
 */
export function readPromptStashQueue(
  queues: PromptStashQueues,
  scopeKey: string,
): PromptStashEntry[] {
  return Object.hasOwn(queues, scopeKey) ? (queues[scopeKey] ?? []) : [];
}

export function stashEntryInQueues(
  queues: PromptStashQueues,
  entry: PromptStashEntry,
): { queues: PromptStashQueues; evicted: PromptStashEntry | null } {
  const scopeKey = buildPromptStashScopeKey(entry.provider);
  const nextQueue = [entry, ...readPromptStashQueue(queues, scopeKey)];
  const evicted = nextQueue.length > MAX_STASH_ENTRIES_PER_QUEUE ? (nextQueue.pop() ?? null) : null;
  return { queues: { ...queues, [scopeKey]: nextQueue }, evicted };
}

export function mergeHydratedPromptStashQueues(
  persisted: PromptStashQueues | undefined,
  current: PromptStashQueues,
): PromptStashQueues {
  if (!persisted) return current;
  const merged: PromptStashQueues = { ...persisted };
  for (const [scopeKey, currentQueue] of Object.entries(current)) {
    const seen = new Set(currentQueue.map((entry) => entry.id));
    merged[scopeKey] = [
      ...currentQueue,
      ...readPromptStashQueue(persisted, scopeKey).filter((entry) => !seen.has(entry.id)),
    ].slice(0, MAX_STASH_ENTRIES_PER_QUEUE);
  }
  return merged;
}

export function takeEntryFromQueues(
  queues: PromptStashQueues,
  scopeKey: string,
  entryId: string,
): { queues: PromptStashQueues; entry: PromptStashEntry | null } {
  const queue = readPromptStashQueue(queues, scopeKey);
  const entry = queue.find((candidate) => candidate.id === entryId) ?? null;
  if (!entry) {
    return { queues, entry: null };
  }
  const nextQueue = queue.filter((candidate) => candidate.id !== entryId);
  const nextQueues = { ...queues };
  if (nextQueue.length === 0) {
    delete nextQueues[scopeKey];
  } else {
    nextQueues[scopeKey] = nextQueue;
  }
  return { queues: nextQueues, entry };
}

export function countOtherScopeEntries(queues: PromptStashQueues, scopeKey: string): number {
  let total = 0;
  for (const [key, queue] of Object.entries(queues)) {
    if (key !== scopeKey) {
      total += queue.length;
    }
  }
  return total;
}

/**
 * Ids of image attachments referenced by stashed prompts. Only images live in
 * the local attachment blob store; every other attachment kind is
 * self-contained metadata.
 */
export function collectStashAttachmentIds(queues: PromptStashQueues): Set<string> {
  const ids = new Set<string>();
  for (const queue of Object.values(queues)) {
    for (const entry of queue) {
      for (const attachment of entry.attachments) {
        if (attachment.kind === "image") {
          ids.add(attachment.metadata.id);
        }
      }
    }
  }
  return ids;
}

/**
 * Restored text is appended to whatever is already in the composer; an
 * attachment-only entry must not add blank lines to existing text.
 */
export function mergeStashRestoreText(currentText: string, stashedText: string): string {
  if (stashedText.length === 0) {
    return currentText;
  }
  const trimmed = currentText.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${stashedText}` : stashedText;
}

function attachmentIdentityKey(attachment: UserComposerAttachment): string {
  switch (attachment.kind) {
    case "image":
      return `image:${attachment.metadata.id}`;
    case "file":
      return `file:${attachment.attachment.id}`;
    case "workspace_file":
      return `workspace_file:${getWorkspaceFileAttachmentKey(attachment)}`;
    case "plugin_resource":
      return `plugin_resource:${attachment.pluginId}:${attachment.sourceId}:${attachment.item.id}`;
    default:
      return `${attachment.kind}:${attachment.item.kind}:${attachment.item.number}`;
  }
}

/** Appends restored attachments, skipping ones the composer already holds. */
export function mergeStashRestoreAttachments(
  current: UserComposerAttachment[],
  restored: UserComposerAttachment[],
): UserComposerAttachment[] {
  const seen = new Set(current.map(attachmentIdentityKey));
  const merged = [...current];
  for (const attachment of restored) {
    const key = attachmentIdentityKey(attachment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}
