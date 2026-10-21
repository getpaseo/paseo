import type { ComposerAttachment } from "@/attachments/types";

export interface HostPromptQueuePreview {
  id: string;
  text: string;
}

export interface LocalQueuedPrompt {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

export function hostOwnsPromptQueue(features: { promptQueue?: boolean } | undefined): boolean {
  return features?.promptQueue === true;
}

/**
 * Mirror the host queue into the local chip list.
 * Returns null when the daemon did not send a queue, so a local-only queue stays put.
 * Attachments stay with the chip that already has them; the host preview is text only.
 */
export function applyHostPromptQueue(
  current: ReadonlyMap<string, LocalQueuedPrompt[]>,
  agentId: string,
  hostItems: readonly HostPromptQueuePreview[] | undefined,
): Map<string, LocalQueuedPrompt[]> | null {
  if (!hostItems) return null;
  const existing = current.get(agentId) ?? [];
  const nextItems = hostItems.map((item) => ({
    id: item.id,
    text: item.text,
    attachments: existing.find((queued) => queued.id === item.id)?.attachments ?? [],
  }));
  if (
    existing.length === nextItems.length &&
    existing.every(
      (item, index) => item.id === nextItems[index]?.id && item.text === nextItems[index]?.text,
    )
  ) {
    return current as Map<string, LocalQueuedPrompt[]>;
  }
  const next = new Map(current);
  next.set(agentId, nextItems);
  return next;
}
