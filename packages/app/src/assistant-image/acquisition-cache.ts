import { createPreviewAttachmentId } from "@/attachments/utils";

export interface AssistantImageAcquisitionCache<T> {
  acquire(key: string, locate: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createAssistantImageFilePreviewAttachmentId(input: {
  occurrenceKey: string;
  mimeType: string;
  path: string;
  size: number;
  modifiedAt?: string | null;
  contentLength: number;
}): string {
  return createPreviewAttachmentId({
    mimeType: input.mimeType,
    path: input.path,
    size: input.size,
    modifiedAt: input.modifiedAt,
    contentLength: input.contentLength,
    contentKey: input.occurrenceKey,
  });
}

export function createAssistantImageFileAcquisitionKey(input: {
  serverId?: string;
  occurrenceKey: string;
  cwd: string;
  path: string;
}): string {
  return `file:${input.serverId ?? "unknown-server"}:${input.occurrenceKey}:${input.cwd}:${input.path}`;
}

export function createAssistantImageAcquisitionCache<T>(input: {
  capacity: number;
  onRetain?: (value: T) => () => void;
}): AssistantImageAcquisitionCache<T> {
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    throw new Error("Assistant image acquisition cache capacity must be a positive integer.");
  }
  interface CacheEntry {
    pending: Promise<T>;
    release: (() => void) | null;
  }
  const entries = new Map<string, CacheEntry>();

  const evict = (key: string, entry: CacheEntry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
    entry.release?.();
    entry.release = null;
  };

  return {
    acquire(key, locate) {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.pending;
      }
      const pending = locate();
      const entry: CacheEntry = { pending, release: null };
      entries.set(key, entry);
      if (entries.size > input.capacity) {
        const leastRecentlyUsedKey = entries.keys().next().value;
        if (leastRecentlyUsedKey !== undefined) {
          const leastRecentlyUsedEntry = entries.get(leastRecentlyUsedKey);
          if (leastRecentlyUsedEntry) {
            evict(leastRecentlyUsedKey, leastRecentlyUsedEntry);
          }
        }
      }
      void (async () => {
        try {
          const value = await pending;
          if (entries.get(key) === entry) {
            entry.release = input.onRetain?.(value) ?? null;
          }
        } catch {
          evict(key, entry);
        }
      })();
      return pending;
    },
    size() {
      return entries.size;
    },
  };
}
