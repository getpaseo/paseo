import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInitialUnistylesSettings } from "./resolve-initial-unistyles-settings";

const APP_SETTINGS_STORAGE_KEY = "@paseo:app-settings";

function installMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memory,
  });
  return memory;
}

describe("resolveInitialUnistylesSettings", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("uses adaptiveThemes when no persisted theme or auto", () => {
    expect(resolveInitialUnistylesSettings()).toEqual({ adaptiveThemes: true });
    globalThis.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ theme: "auto" }));
    expect(resolveInitialUnistylesSettings()).toEqual({ adaptiveThemes: true });
  });

  it("uses initialTheme for a named persisted theme", () => {
    globalThis.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ theme: "claude" }));
    expect(resolveInitialUnistylesSettings()).toEqual({ initialTheme: "darkClaude" });
  });
});
