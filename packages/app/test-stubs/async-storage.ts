/**
 * AsyncStorage has no implementation under Node: its default export reaches for
 * the native module and every call rejects, so any test that touches a
 * persisted store emits unhandled rejections from the persist middleware.
 *
 * This is a real in-memory key-value store with the same contract, not a
 * recording double, so a test can read back what a store wrote.
 */
const entries = new Map<string, string>();

export function clearAsyncStorageStub(): void {
  entries.clear();
}

const AsyncStorageStub = {
  getItem: (key: string): Promise<string | null> => Promise.resolve(entries.get(key) ?? null),
  setItem: (key: string, value: string): Promise<void> => {
    entries.set(key, value);
    return Promise.resolve();
  },
  removeItem: (key: string): Promise<void> => {
    entries.delete(key);
    return Promise.resolve();
  },
  getAllKeys: (): Promise<string[]> => Promise.resolve([...entries.keys()]),
  clear: (): Promise<void> => {
    entries.clear();
    return Promise.resolve();
  },
};

export default AsyncStorageStub;
