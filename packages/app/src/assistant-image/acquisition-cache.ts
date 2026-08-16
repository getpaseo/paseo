import { createPreviewAttachmentId } from "@/attachments/utils";

export interface AssistantImageAcquisitionCache<T> {
  acquire(key: string, locate: () => Promise<T>): Promise<T>;
  acquireRetained(
    key: string,
    locate: () => Promise<T>,
  ): { promise: Promise<T>; value?: T; release: () => void };
  peek(key: string): T | undefined;
  size(): number;
}

export function createAssistantImageOccurrenceKey(input: {
  agentId: string;
  itemId: string;
}): string {
  return `${input.agentId}:${input.itemId}`;
}

export function createAssistantImageFilePreviewAttachmentId(input: {
  serverId?: string;
  workspaceId?: string;
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
    contentKey: `${input.serverId ?? "unknown-server"}:${input.workspaceId ?? "legacy-workspace"}:${input.occurrenceKey}`,
  });
}

export function createAssistantImageFileAcquisitionKey(input: {
  serverId?: string;
  workspaceId?: string;
  occurrenceKey: string;
  cwd: string;
  path: string;
}): string {
  return `file:${input.serverId ?? "unknown-server"}:${input.workspaceId ?? "legacy-workspace"}:${input.occurrenceKey}:${input.cwd}:${input.path}`;
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
    resolved: boolean;
    value?: T;
    release: (() => void) | null;
    activeConsumers: number;
  }
  const entries = new Map<string, CacheEntry>();

  const evict = (key: string, entry: CacheEntry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
    entry.release?.();
    entry.release = null;
  };

  const enforceCapacity = () => {
    while (entries.size > input.capacity) {
      let evicted = false;
      for (const [key, entry] of entries) {
        if (entry.activeConsumers > 0) {
          continue;
        }
        evict(key, entry);
        evicted = true;
        break;
      }
      if (!evicted) {
        return;
      }
    }
  };

  const acquireEntry = (key: string, locate: () => Promise<T>, retain: boolean): CacheEntry => {
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      if (retain) {
        cached.activeConsumers += 1;
      }
      return cached;
    }
    const pending = locate();
    const entry: CacheEntry = {
      pending,
      resolved: false,
      release: null,
      activeConsumers: retain ? 1 : 0,
    };
    entries.set(key, entry);
    enforceCapacity();
    void (async () => {
      try {
        const value = await pending;
        const release = input.onRetain?.(value) ?? null;
        if (entries.get(key) === entry) {
          entry.value = value;
          entry.resolved = true;
          entry.release = release;
        } else {
          release?.();
        }
      } catch {
        evict(key, entry);
      }
    })();
    return entry;
  };

  return {
    acquire(key, locate) {
      return acquireEntry(key, locate, false).pending;
    },
    acquireRetained(key, locate) {
      const entry = acquireEntry(key, locate, true);
      let released = false;
      return {
        promise: entry.pending,
        ...(entry.resolved ? { value: entry.value } : {}),
        release() {
          if (released) {
            return;
          }
          released = true;
          entry.activeConsumers = Math.max(0, entry.activeConsumers - 1);
          enforceCapacity();
        },
      };
    },
    peek(key) {
      const entry = entries.get(key);
      if (!entry?.resolved) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    size() {
      return entries.size;
    },
  };
}
