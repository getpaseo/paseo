export interface AssistantImageAcquisitionCache<T> {
  acquire(key: string, locate: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createAssistantImageAcquisitionCache<T>(input: {
  capacity: number;
}): AssistantImageAcquisitionCache<T> {
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    throw new Error("Assistant image acquisition cache capacity must be a positive integer.");
  }
  const entries = new Map<string, Promise<T>>();

  return {
    acquire(key, locate) {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const pending = locate();
      entries.set(key, pending);
      if (entries.size > input.capacity) {
        const leastRecentlyUsedKey = entries.keys().next().value;
        if (leastRecentlyUsedKey !== undefined) {
          entries.delete(leastRecentlyUsedKey);
        }
      }
      void (async () => {
        try {
          await pending;
        } catch {
          if (entries.get(key) === pending) {
            entries.delete(key);
          }
        }
      })();
      return pending;
    },
    size() {
      return entries.size;
    },
  };
}
