import type { KeyValueStorage } from "./storage";

export interface InMemoryKeyValueStorage extends KeyValueStorage {
  readonly entries: Map<string, string>;
}

export function createInMemoryKeyValueStorage(
  initial: Record<string, string> = {},
): InMemoryKeyValueStorage {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    async getItem(key) {
      return entries.get(key) ?? null;
    },
    async setItem(key, value) {
      entries.set(key, value);
    },
  };
}
