import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsKeyValueStorage } from "@/storage/settings-seed/layered-storage";
import {
  type ClientSettingsFields,
  createClientSettingsBaseStorage,
} from "./client-settings-store";

const APP_SETTINGS_KEY = "@paseo:app-settings";
const SHORTCUTS_KEY = "@paseo:keyboard-shortcut-overrides";
const PREFERRED_EDITOR_KEY = "@paseo:preferred-editor";
const DAEMON_REGISTRY_KEY = "@paseo:daemon-registry";

interface FakeFallback extends SettingsKeyValueStorage {
  readonly entries: Map<string, string>;
}

function createFallback(initial: Record<string, string> = {}): FakeFallback {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    async getItem(key) {
      return entries.get(key) ?? null;
    },
    async setItem(key, value) {
      entries.set(key, value);
    },
    async removeItem(key) {
      entries.delete(key);
    },
  };
}

/** Stands in for the main process: one document on "disk", plus call counts for the IPC pair. */
function createFakeMain(initial: ClientSettingsFields | null = null) {
  let document: ClientSettingsFields | null = initial;
  const getDocument = vi.fn(async () => (document ? { app: { ...document } } : null));
  const setField = vi.fn(async (field: string, value: unknown) => {
    document ??= {};
    if (value === null) {
      delete document[field];
    } else {
      document[field] = value;
    }
  });
  const initialize = vi.fn(async (entries: ClientSettingsFields) => {
    document ??= { ...entries };
    return { app: { ...document } };
  });
  return {
    getDocument,
    setField,
    initialize,
    get file(): ClientSettingsFields | null {
      return document;
    },
  };
}

function createStore(main: ReturnType<typeof createFakeMain>, fallback: FakeFallback) {
  return createClientSettingsBaseStorage({
    fallback,
    getDocument: main.getDocument,
    setField: main.setField,
    initialize: main.initialize,
  });
}

async function documentWrittenByAnotherWindow(): Promise<{ app: ClientSettingsFields }> {
  return { app: { preferredEditor: "vscode" } };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("client-settings-store", () => {
  describe("registered keys", () => {
    it("reads a struct field back as JSON", async () => {
      const main = createFakeMain({ appSettings: { theme: "dark" } });
      const store = createStore(main, createFallback());

      await expect(store.getItem(APP_SETTINGS_KEY)).resolves.toBe('{"theme":"dark"}');
    });

    it("reads a scalar field back as the raw string", async () => {
      const main = createFakeMain({ preferredEditor: "zed" });
      const store = createStore(main, createFallback());

      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBe("zed");
    });

    it("returns null for a field the file does not define", async () => {
      const main = createFakeMain({ preferredEditor: "zed" });
      const store = createStore(main, createFallback());

      await expect(store.getItem(APP_SETTINGS_KEY)).resolves.toBeNull();
    });

    it("writes object kinds into the file as objects", async () => {
      const fallback = createFallback();
      const main = createFakeMain({});
      const store = createStore(main, fallback);

      await store.setItem(SHORTCUTS_KEY, '{"toggle":"cmd+k"}');

      expect(main.setField).toHaveBeenCalledWith("keyboardShortcutOverrides", {
        toggle: "cmd+k",
      });
      expect(main.file).toEqual({ keyboardShortcutOverrides: { toggle: "cmd+k" } });
      expect(fallback.entries.has(SHORTCUTS_KEY)).toBe(false);
    });

    it("writes scalar kinds into the file as raw strings", async () => {
      const main = createFakeMain({});
      const store = createStore(main, createFallback());

      await store.setItem(PREFERRED_EDITOR_KEY, "vscode");

      expect(main.setField).toHaveBeenCalledWith("preferredEditor", "vscode");
      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBe("vscode");
    });

    it("removes a field by setting it to null", async () => {
      const main = createFakeMain({ preferredEditor: "zed", appSettings: { theme: "dark" } });
      const store = createStore(main, createFallback());

      await store.removeItem(PREFERRED_EDITOR_KEY);

      expect(main.setField).toHaveBeenCalledWith("preferredEditor", null);
      expect(main.file).toEqual({ appSettings: { theme: "dark" } });
      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBeNull();
    });

    it("ignores a field whose shape does not match its kind", async () => {
      const main = createFakeMain({ appSettings: 7, preferredEditor: { nested: true } });
      const store = createStore(main, createFallback());

      await expect(store.getItem(APP_SETTINGS_KEY)).resolves.toBeNull();
      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBeNull();
    });

    it("round-trips a value the app wrote that is not a JSON object", async () => {
      const main = createFakeMain({});
      const store = createStore(main, createFallback());

      await store.setItem(APP_SETTINGS_KEY, "not json");

      await expect(store.getItem(APP_SETTINGS_KEY)).resolves.toBe("not json");
    });

    it("fetches the document once per page load", async () => {
      const main = createFakeMain({ preferredEditor: "zed" });
      const store = createStore(main, createFallback());

      await store.getItem(PREFERRED_EDITOR_KEY);
      await store.setItem(PREFERRED_EDITOR_KEY, "vscode");
      await store.getItem(PREFERRED_EDITOR_KEY);

      expect(main.getDocument).toHaveBeenCalledTimes(1);
    });

    it("propagates an unreadable settings file instead of falling back to local storage", async () => {
      const fallback = createFallback({ [PREFERRED_EDITOR_KEY]: "vscode" });
      const store = createClientSettingsBaseStorage({
        fallback,
        getDocument: async () => {
          throw new Error("[ClientSettings] Invalid JSON in /tmp/settings.json");
        },
        setField: vi.fn(),
        initialize: vi.fn(),
      });

      await expect(store.getItem(PREFERRED_EDITOR_KEY)).rejects.toThrow("Invalid JSON");
    });
  });

  describe("unregistered keys", () => {
    it("reads, writes and removes straight through to local storage", async () => {
      const fallback = createFallback({ [DAEMON_REGISTRY_KEY]: '{"servers":[]}' });
      const main = createFakeMain({});
      const store = createStore(main, fallback);

      await expect(store.getItem(DAEMON_REGISTRY_KEY)).resolves.toBe('{"servers":[]}');
      await store.setItem(DAEMON_REGISTRY_KEY, '{"servers":["a"]}');
      expect(fallback.entries.get(DAEMON_REGISTRY_KEY)).toBe('{"servers":["a"]}');
      await store.removeItem(DAEMON_REGISTRY_KEY);
      expect(fallback.entries.has(DAEMON_REGISTRY_KEY)).toBe(false);

      expect(main.getDocument).not.toHaveBeenCalled();
      expect(main.setField).not.toHaveBeenCalled();
    });
  });

  describe("migration", () => {
    it("seeds the file from the registered local storage keys", async () => {
      const fallback = createFallback({
        [APP_SETTINGS_KEY]: '{"theme":"dark"}',
        [PREFERRED_EDITOR_KEY]: "zed",
        [DAEMON_REGISTRY_KEY]: '{"servers":[]}',
      });
      const main = createFakeMain(null);
      const store = createStore(main, fallback);

      await expect(store.getItem(APP_SETTINGS_KEY)).resolves.toBe('{"theme":"dark"}');

      expect(main.initialize).toHaveBeenCalledWith({
        appSettings: { theme: "dark" },
        preferredEditor: "zed",
      });
      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBe("zed");
    });

    it("leaves the legacy local storage values in place", async () => {
      const fallback = createFallback({ [PREFERRED_EDITOR_KEY]: "zed" });
      const store = createStore(createFakeMain(null), fallback);

      await store.getItem(PREFERRED_EDITOR_KEY);

      expect(fallback.entries.get(PREFERRED_EDITOR_KEY)).toBe("zed");
    });

    it("does not run once a file exists, even an empty one", async () => {
      const fallback = createFallback({ [PREFERRED_EDITOR_KEY]: "zed" });
      const main = createFakeMain({});
      const store = createStore(main, fallback);

      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBeNull();
      expect(main.initialize).not.toHaveBeenCalled();
    });

    it("adopts the document a racing window already wrote", async () => {
      const fallback = createFallback({ [PREFERRED_EDITOR_KEY]: "zed" });
      const main = createFakeMain(null);
      // The other window won: the file exists by the time initialize lands.
      main.initialize.mockImplementationOnce(documentWrittenByAnotherWindow);
      const store = createStore(main, fallback);

      await expect(store.getItem(PREFERRED_EDITOR_KEY)).resolves.toBe("vscode");
    });

    it("is idempotent across reloads", async () => {
      const fallback = createFallback({ [PREFERRED_EDITOR_KEY]: "zed" });
      const main = createFakeMain(null);

      const first = createStore(main, fallback);
      await first.getItem(PREFERRED_EDITOR_KEY);
      await first.setItem(PREFERRED_EDITOR_KEY, "vscode");

      const second = createStore(main, fallback);
      await expect(second.getItem(PREFERRED_EDITOR_KEY)).resolves.toBe("vscode");
      expect(main.initialize).toHaveBeenCalledTimes(1);
    });
  });
});
