import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLayeredSettingsStorage,
  SeedShadowedError,
  type SettingsKeyValueStorage,
} from "./layered-storage";
import type { SettingsSeed } from "./types";

const APP_SETTINGS_KEY = "@paseo:app-settings";
const SHORTCUTS_KEY = "@paseo:keyboard-shortcut-overrides";
const PREFERRED_EDITOR_KEY = "@paseo:preferred-editor";
const DAEMON_REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_PATH = "/etc/paseo/settings.json";

interface FakeBaseStorage extends SettingsKeyValueStorage {
  readonly entries: Map<string, string>;
}

function createBaseStorage(initial: Record<string, string> = {}): FakeBaseStorage {
  const entries = new Map<string, string>(Object.entries(initial));
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

function createStorage(input: {
  base: FakeBaseStorage;
  seed?: Record<string, unknown> | null;
}): SettingsKeyValueStorage {
  const seed: SettingsSeed | null = input.seed ? { path: SEED_PATH, app: input.seed } : null;
  return createLayeredSettingsStorage({
    base: input.base,
    loadSeed: async () => seed,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("without a seed", () => {
  it("passes registered keys through byte for byte", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: null });
    const stored = JSON.stringify({ theme: "dark", uiFontSize: 18 });

    await storage.setItem(APP_SETTINGS_KEY, stored);

    expect(base.entries.get(APP_SETTINGS_KEY)).toBe(stored);
    expect(await storage.getItem(APP_SETTINGS_KEY)).toBe(stored);

    await storage.removeItem(APP_SETTINGS_KEY);
    expect(base.entries.has(APP_SETTINGS_KEY)).toBe(false);
    expect(await storage.getItem(APP_SETTINGS_KEY)).toBeNull();
  });

  it("passes the scalar key through byte for byte", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: null });

    await storage.setItem(PREFERRED_EDITOR_KEY, "vscode");

    expect(base.entries.get(PREFERRED_EDITOR_KEY)).toBe("vscode");
    expect(await storage.getItem(PREFERRED_EDITOR_KEY)).toBe("vscode");

    await storage.removeItem(PREFERRED_EDITOR_KEY);
    expect(base.entries.has(PREFERRED_EDITOR_KEY)).toBe(false);
  });

  it("passes unregistered keys through byte for byte", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: null });

    await storage.setItem(DAEMON_REGISTRY_KEY, '{"daemons":[{"id":"local"}]}');

    expect(base.entries.get(DAEMON_REGISTRY_KEY)).toBe('{"daemons":[{"id":"local"}]}');
    expect(await storage.getItem(DAEMON_REGISTRY_KEY)).toBe('{"daemons":[{"id":"local"}]}');
  });
});

describe("keys outside the registry", () => {
  it("ignores a seed that names an unregistered key", async () => {
    const base = createBaseStorage({ [DAEMON_REGISTRY_KEY]: '{"daemons":[]}' });
    const storage = createStorage({
      base,
      seed: {
        daemonRegistry: { daemons: [{ id: "seeded" }] },
        "@paseo:daemon-registry": { daemons: [{ id: "seeded" }] },
      },
    });

    expect(await storage.getItem(DAEMON_REGISTRY_KEY)).toBe('{"daemons":[]}');

    await storage.setItem(DAEMON_REGISTRY_KEY, '{"daemons":[{"id":"local"}]}');
    expect(base.entries.get(DAEMON_REGISTRY_KEY)).toBe('{"daemons":[{"id":"local"}]}');

    await storage.removeItem(DAEMON_REGISTRY_KEY);
    expect(base.entries.has(DAEMON_REGISTRY_KEY)).toBe(false);
  });

  it("ignores a registered key the seed does not define", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });
    const stored = JSON.stringify({ theme: "dark" });

    await storage.setItem(APP_SETTINGS_KEY, stored);

    expect(base.entries.get(APP_SETTINGS_KEY)).toBe(stored);
    await expect(storage.removeItem(APP_SETTINGS_KEY)).resolves.toBeUndefined();
  });
});

describe("struct keys", () => {
  it("merges the seed under the local value", async () => {
    const base = createBaseStorage({
      [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }),
    });
    const storage = createStorage({
      base,
      seed: { appSettings: { theme: "dark", uiFontSize: 18 } },
    });

    const merged = JSON.parse((await storage.getItem(APP_SETTINGS_KEY)) ?? "null");

    expect(merged).toEqual({ theme: "light", uiFontSize: 18 });
  });

  it("returns the seed value when nothing is stored locally", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { appSettings: { theme: "dark" } } });

    expect(JSON.parse((await storage.getItem(APP_SETTINGS_KEY)) ?? "null")).toEqual({
      theme: "dark",
    });
  });

  it("merges nested objects instead of replacing them", async () => {
    const base = createBaseStorage({
      [APP_SETTINGS_KEY]: JSON.stringify({ sidebarRowItems: { diff: false } }),
    });
    const storage = createStorage({
      base,
      seed: { appSettings: { sidebarRowItems: { diff: true, branch: true } } },
    });

    expect(JSON.parse((await storage.getItem(APP_SETTINGS_KEY)) ?? "null")).toEqual({
      sidebarRowItems: { diff: false, branch: true },
    });
  });

  it("persists only the difference against the seed", async () => {
    const base = createBaseStorage();
    const storage = createStorage({
      base,
      seed: { appSettings: { theme: "dark", uiFontSize: 18 } },
    });

    await storage.setItem(
      APP_SETTINGS_KEY,
      JSON.stringify({ theme: "dark", uiFontSize: 20, language: "en" }),
    );

    expect(JSON.parse(base.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({
      uiFontSize: 20,
      language: "en",
    });
  });

  it("drops a local override once it matches the seed again", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { appSettings: { theme: "dark" } } });

    await storage.setItem(APP_SETTINGS_KEY, JSON.stringify({ theme: "light" }));
    expect(JSON.parse(base.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({ theme: "light" });

    await storage.setItem(APP_SETTINGS_KEY, JSON.stringify({ theme: "dark" }));
    expect(JSON.parse(base.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({});
    expect(JSON.parse((await storage.getItem(APP_SETTINGS_KEY)) ?? "null")).toEqual({
      theme: "dark",
    });
  });

  it("saves normally when the seed carries fields the store does not write", async () => {
    const base = createBaseStorage();
    const storage = createStorage({
      base,
      seed: { appSettings: { theme: "dark", someRemovedSetting: true } },
    });

    await storage.setItem(APP_SETTINGS_KEY, JSON.stringify({ theme: "light" }));

    expect(JSON.parse(base.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({ theme: "light" });
  });

  it("rejects a reset while the seed defines values", async () => {
    const base = createBaseStorage({ [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }) });
    const storage = createStorage({ base, seed: { appSettings: { theme: "dark" } } });

    await expect(storage.removeItem(APP_SETTINGS_KEY)).rejects.toThrow(SeedShadowedError);
    expect(base.entries.has(APP_SETTINGS_KEY)).toBe(true);
  });

  it("allows a reset when the seed section is empty", async () => {
    const base = createBaseStorage({ [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }) });
    const storage = createStorage({ base, seed: { appSettings: {} } });

    await storage.removeItem(APP_SETTINGS_KEY);

    expect(base.entries.has(APP_SETTINGS_KEY)).toBe(false);
  });
});

describe("record keys", () => {
  it("merges the seed under the local overrides", async () => {
    const base = createBaseStorage({
      [SHORTCUTS_KEY]: JSON.stringify({ "chat.send": "Cmd+Enter" }),
    });
    const storage = createStorage({
      base,
      seed: { keyboardShortcutOverrides: { "chat.send": "Enter", "chat.new": "Cmd+N" } },
    });

    expect(JSON.parse((await storage.getItem(SHORTCUTS_KEY)) ?? "null")).toEqual({
      "chat.send": "Cmd+Enter",
      "chat.new": "Cmd+N",
    });
  });

  it("persists only the entries that differ from the seed", async () => {
    const base = createBaseStorage();
    const storage = createStorage({
      base,
      seed: { keyboardShortcutOverrides: { "chat.send": "Enter", "chat.new": "Cmd+N" } },
    });

    await storage.setItem(
      SHORTCUTS_KEY,
      JSON.stringify({ "chat.send": "Cmd+Enter", "chat.new": "Cmd+N", "chat.close": "Cmd+W" }),
    );

    expect(JSON.parse(base.entries.get(SHORTCUTS_KEY) ?? "null")).toEqual({
      "chat.send": "Cmd+Enter",
      "chat.close": "Cmd+W",
    });
  });

  it("rejects deleting a seed-provided entry and names the seed file", async () => {
    const base = createBaseStorage();
    const storage = createStorage({
      base,
      seed: { keyboardShortcutOverrides: { "chat.send": "Enter", "chat.new": "Cmd+N" } },
    });

    const error = await storage
      .setItem(SHORTCUTS_KEY, JSON.stringify({ "chat.send": "Enter" }))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SeedShadowedError);
    expect((error as SeedShadowedError).message).toBe(
      `[Settings] Cannot remove "chat.new": it is defined in ${SEED_PATH}. Change it there instead.`,
    );
    expect((error as SeedShadowedError).entry).toBe("chat.new");
    expect((error as SeedShadowedError).storageKey).toBe(SHORTCUTS_KEY);
    expect((error as SeedShadowedError).seedPath).toBe(SEED_PATH);
    expect(base.entries.has(SHORTCUTS_KEY)).toBe(false);
  });

  it("rejects a reset while the seed defines entries", async () => {
    const base = createBaseStorage({ [SHORTCUTS_KEY]: JSON.stringify({ "chat.send": "Enter" }) });
    const storage = createStorage({
      base,
      seed: { keyboardShortcutOverrides: { "chat.new": "Cmd+N" } },
    });

    await expect(storage.removeItem(SHORTCUTS_KEY)).rejects.toThrow(
      `[Settings] Cannot reset "${SHORTCUTS_KEY}": values are defined in ${SEED_PATH}. Change them there instead.`,
    );
    expect(base.entries.has(SHORTCUTS_KEY)).toBe(true);
  });

  it("allows a reset when the seed record is empty", async () => {
    const base = createBaseStorage({ [SHORTCUTS_KEY]: JSON.stringify({ "chat.send": "Enter" }) });
    const storage = createStorage({ base, seed: { keyboardShortcutOverrides: {} } });

    await storage.removeItem(SHORTCUTS_KEY);

    expect(base.entries.has(SHORTCUTS_KEY)).toBe(false);
  });
});

describe("scalar keys", () => {
  it("returns the seed value when nothing is stored locally", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });

    expect(await storage.getItem(PREFERRED_EDITOR_KEY)).toBe("zed");
  });

  it("lets the local value win", async () => {
    const base = createBaseStorage({ [PREFERRED_EDITOR_KEY]: "vscode" });
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });

    expect(await storage.getItem(PREFERRED_EDITOR_KEY)).toBe("vscode");
  });

  it("drops a redundant local copy of the seed value", async () => {
    const base = createBaseStorage({ [PREFERRED_EDITOR_KEY]: "vscode" });
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });

    await storage.setItem(PREFERRED_EDITOR_KEY, "zed");

    expect(base.entries.has(PREFERRED_EDITOR_KEY)).toBe(false);
    expect(await storage.getItem(PREFERRED_EDITOR_KEY)).toBe("zed");
  });

  it("stores a value that differs from the seed", async () => {
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });

    await storage.setItem(PREFERRED_EDITOR_KEY, "cursor");

    expect(base.entries.get(PREFERRED_EDITOR_KEY)).toBe("cursor");
  });

  it("rejects clearing the value while the seed defines it", async () => {
    const base = createBaseStorage({ [PREFERRED_EDITOR_KEY]: "vscode" });
    const storage = createStorage({ base, seed: { preferredEditor: "zed" } });

    await expect(storage.removeItem(PREFERRED_EDITOR_KEY)).rejects.toThrow(SeedShadowedError);
    expect(base.entries.get(PREFERRED_EDITOR_KEY)).toBe("vscode");
  });
});

describe("malformed input", () => {
  it("returns the stored string unchanged when the local value is not JSON", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = createBaseStorage({ [APP_SETTINGS_KEY]: "not json" });
    const storage = createStorage({ base, seed: { appSettings: { theme: "dark" } } });

    expect(await storage.getItem(APP_SETTINGS_KEY)).toBe("not json");
    expect(consoleError).toHaveBeenCalled();
  });

  it("writes an unparseable value through unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = createBaseStorage();
    const storage = createStorage({ base, seed: { appSettings: { theme: "dark" } } });

    await storage.setItem(APP_SETTINGS_KEY, "not json");

    expect(base.entries.get(APP_SETTINGS_KEY)).toBe("not json");
  });

  it("ignores a seed value of the wrong shape", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = createBaseStorage({ [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }) });
    const storage = createStorage({
      base,
      seed: { appSettings: "dark", preferredEditor: { id: "zed" } },
    });

    expect(await storage.getItem(APP_SETTINGS_KEY)).toBe(JSON.stringify({ theme: "light" }));
    expect(await storage.getItem(PREFERRED_EDITOR_KEY)).toBeNull();

    await storage.setItem(APP_SETTINGS_KEY, JSON.stringify({ theme: "dark" }));
    expect(base.entries.get(APP_SETTINGS_KEY)).toBe(JSON.stringify({ theme: "dark" }));

    await storage.removeItem(APP_SETTINGS_KEY);
    expect(base.entries.has(APP_SETTINGS_KEY)).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });
});
