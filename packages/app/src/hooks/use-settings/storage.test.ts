import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  loadAppSettingsFromStorage,
  loadSettingsFromStorage,
  parseClampedFontSize,
  parseTerminalScrollbackLines,
  saveAppSettings,
  type SettingsDeps,
} from "./storage";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "./fakes";

const LEGACY_SETTINGS_KEY = "@paseo:settings";

function makeDeps(
  overrides: {
    storage?: ReturnType<typeof createInMemoryKeyValueStorage>;
    desktop?: ReturnType<typeof createFakeDesktopBridge>;
  } = {},
): SettingsDeps & {
  storage: ReturnType<typeof createInMemoryKeyValueStorage>;
  desktop: ReturnType<typeof createFakeDesktopBridge>;
} {
  return {
    storage: overrides.storage ?? createInMemoryKeyValueStorage(),
    desktop: overrides.desktop ?? createFakeDesktopBridge(),
  };
}

describe("loadAppSettingsFromStorage", () => {
  it("defaults theme to auto when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.theme).toBe("auto");
  });

  it("seeds storage with the client defaults when nothing is persisted", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result).toEqual(DEFAULT_CLIENT_SETTINGS);
    expect(DEFAULT_CLIENT_SETTINGS.language).toBe("system");
    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(
      JSON.stringify(DEFAULT_CLIENT_SETTINGS),
    );
  });

  it("defaults language to system when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("system");
  });

  it("loads configured terminal scrollback lines from app settings", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ terminalScrollbackLines: 42_000 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.terminalScrollbackLines).toBe(42_000);
  });

  it("normalizes terminal scrollback lines from storage", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ terminalScrollbackLines: 1_000_000.9 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.terminalScrollbackLines).toBe(1_000_000);
  });

  it("migrates the legacy theme key into the new settings object", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({
          theme: "dark",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      theme: "dark",
    });
    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(JSON.stringify(result));
  });

  it("loads a persisted explicit language", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ language: "zh-CN" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("zh-CN");
  });

  it("drops an unknown persisted language back to system", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ language: "klingon" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("system");
  });
});

describe("loadSettingsFromStorage", () => {
  it("defaults built-in daemon management to enabled when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadSettingsFromStorage(deps);

    expect(result).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("defaults release channel to stable when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadSettingsFromStorage(deps);

    expect(result.releaseChannel).toBe("stable");
  });

  it("ignores renderer-owned daemon management state outside Electron", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
        }),
      }),
    });

    const result = await loadSettingsFromStorage(deps);

    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
    });
  });

  it("ignores renderer-owned release channel outside Electron", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ releaseChannel: "beta" }),
      }),
    });

    const result = await loadSettingsFromStorage(deps);

    expect(result.releaseChannel).toBe("stable");
  });

  it("migrates legacy desktop-owned settings through the bridge before reading effective settings", async () => {
    const desktop = createFakeDesktopBridge({
      isElectron: true,
      settings: {
        releaseChannel: "beta",
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
      },
    });
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        }),
      }),
      desktop,
    });

    const result = await loadSettingsFromStorage(deps);

    expect(desktop.migrationsApplied).toEqual([
      { manageBuiltInDaemon: false, releaseChannel: "beta" },
    ]);
    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
      manageBuiltInDaemon: false,
      releaseChannel: "beta",
    });
  });

  it("does not call the desktop bridge outside Electron", async () => {
    const desktop = createFakeDesktopBridge({ isElectron: false });
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }),
      }),
      desktop,
    });

    const result = await loadSettingsFromStorage(deps);

    expect(desktop.migrationsApplied).toEqual([]);
    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
    });
  });
});

describe("saveAppSettings", () => {
  it("saves terminal scrollback through app settings persistence", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify(DEFAULT_CLIENT_SETTINGS),
      }),
    });
    const queryClient = new QueryClient();

    await saveAppSettings({
      queryClient,
      updates: { terminalScrollbackLines: 42_000 },
      deps,
    });

    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        terminalScrollbackLines: 42_000,
      }),
    );
  });
});

describe("parseTerminalScrollbackLines", () => {
  it("clamps negative values to the minimum and rejects non-numeric strings", () => {
    expect(parseTerminalScrollbackLines("-10")).toBe(0);
    expect(parseTerminalScrollbackLines("abc")).toBeNull();
  });
});

describe("appearance settings", () => {
  it("defaults the appearance fields when an old blob omits them", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: "dark" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiFontFamily).toBe("");
    expect(result.monoFontFamily).toBe("");
    expect(result.uiFontSize).toBe(DEFAULT_UI_FONT_SIZE);
    expect(result.codeFontSize).toBe(DEFAULT_CODE_FONT_SIZE);
    expect(result.syntaxTheme).toBe("one");
  });

  it("clamps the UI font size into range and rejects non-numeric values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).uiFontSize).toBe(24);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).uiFontSize).toBe(11);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).uiFontSize).toBe(DEFAULT_UI_FONT_SIZE);
  });

  it("clamps the code font size into range and rejects non-numeric values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).codeFontSize).toBe(22);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).codeFontSize).toBe(9);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).codeFontSize).toBe(DEFAULT_CODE_FONT_SIZE);
  });

  it("trims an accepted font family", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "  Menlo  " }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("Menlo");
  });

  it("keeps an explicit empty font family as the default sentinel", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("rejects a font family containing CSS-breaking characters", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "a;b{c}" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("rejects an over-length font family", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "a".repeat(201) }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("accepts a known syntax theme id", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "dracula" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("dracula");
  });

  it("drops a removed syntax theme id back to the default", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "auto" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("one");
  });

  it("drops an unknown syntax theme id back to the default", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "bogus" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("one");
  });
});

describe("parseClampedFontSize", () => {
  it("clamps to the bounds and rejects non-numeric strings", () => {
    expect(parseClampedFontSize(999, { min: 11, max: 24 })).toBe(24);
    expect(parseClampedFontSize(8, { min: 11, max: 24 })).toBe(11);
    expect(parseClampedFontSize("15", { min: 11, max: 24 })).toBe(15);
    expect(parseClampedFontSize("abc", { min: 11, max: 24 })).toBeNull();
  });
});
