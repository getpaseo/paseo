import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_KEY,
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_CONTENT_FONT_SIZE,
  DEFAULT_UI_BASE_FONT_SIZE,
  defaultUiBaseFontSize,
  defaultContentFontSize,
  loadAppSettingsFromStorage,
  loadSettingsFromStorage,
  parseClampedFontSize,
  parseTerminalScrollbackLines,
  saveAppSettings,
  type SettingsDeps,
} from "./storage";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "./fakes";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  SIDEBAR_ROW_ITEMS,
} from "@/components/sidebar/display-preferences/row-items";
import { THEME_OPTIONS } from "@/styles/theme";

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
  it("preserves a persisted steer send behavior", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        "@paseo:app-settings": JSON.stringify({ sendBehavior: "steer" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).sendBehavior).toBe("steer");
  });
  it("migrates a stored interrupt to steer and persists it", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sendBehavior: "interrupt" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.sendBehavior).toBe("steer");
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "{}").sendBehavior).toBe(
      "steer",
    );
  });

  it("keeps an interrupt the user picked after the migration ran", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sendBehavior: "interrupt" }),
      }),
    });
    await loadAppSettingsFromStorage(deps);
    await saveAppSettings({
      queryClient: new QueryClient(),
      updates: { sendBehavior: "interrupt" },
      deps,
    });

    expect((await loadAppSettingsFromStorage(deps)).sendBehavior).toBe("interrupt");
  });

  it("defaults theme to auto when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.theme).toBe("auto");
  });

  it.each(THEME_OPTIONS)("loads the persisted $name theme", async ({ name }) => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: name }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.theme).toBe(name);
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

  it("defaults workspace title source to title when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.workspaceTitleSource).toBe("title");
  });

  it("enables the chat outline by default", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.chatOutlineEnabled).toBe(true);
  });

  it("loads a disabled chat outline preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ chatOutlineEnabled: false }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.chatOutlineEnabled).toBe(false);
  });

  it("uses the native terminal renderer by default", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.useLegacyTerminalRenderer).toBe(false);
  });

  it("loads the per-device legacy terminal renderer preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ useLegacyTerminalRenderer: true }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.useLegacyTerminalRenderer).toBe(true);
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

  it("loads configured workspace title source from app settings", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ workspaceTitleSource: "branch" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.workspaceTitleSource).toBe("branch");
  });

  it("drops an unknown workspace title source back to title", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ workspaceTitleSource: "directory" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.workspaceTitleSource).toBe("title");
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
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
    });
    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(JSON.stringify(result));
  });

  it("preserves the legacy key's explicit interface size as content size", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiBaseFontSize).toBe(17);
    expect(result.contentFontSize).toBe(17);
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toMatchObject({
      uiBaseFontSize: 17,
      contentFontSize: 17,
    });
  });

  it("preserves the legacy interface scale as content size", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({ uiFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiBaseFontSize).toBe(15);
    expect(result.contentFontSize).toBe(15);
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toMatchObject({
      uiBaseFontSize: 15,
      contentFontSize: 15,
    });
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
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
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
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
        power: { keepAwakeWhileAgentsRunning: false },
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
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
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
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
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

  it("normalizes a legacy cached settings shape before saving", async () => {
    const deps = makeDeps();
    const queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
      theme: "dark",
      compactToolCalls: true,
    });

    await saveAppSettings({
      queryClient,
      updates: { theme: "light" },
      deps,
    });

    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      theme: "light",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
      toolCallDetailLevel: "overview",
    });
  });

  it("persists a selected plugin theme", async () => {
    const deps = makeDeps();
    const queryClient = new QueryClient();

    await saveAppSettings({
      queryClient,
      updates: { theme: "plugin", pluginThemeId: "catppuccin/theme/mocha" },
      deps,
    });

    const loaded = await loadAppSettingsFromStorage(deps);
    expect(loaded.theme).toBe("plugin");
    expect(loaded.pluginThemeId).toBe("catppuccin/theme/mocha");
  });

  // The row items are written as one object through one strict schema, so an item the schema
  // does not know does not just fail to persist itself — it takes every sibling toggle with it.
  it.each(SIDEBAR_ROW_ITEMS)("persists the %s row item being switched off", async (item) => {
    const deps = makeDeps();
    const queryClient = new QueryClient();
    const sidebarRowItems = { ...DEFAULT_SIDEBAR_ROW_ITEMS, [item]: false };

    await saveAppSettings({ queryClient, updates: { sidebarRowItems }, deps });

    expect((await loadAppSettingsFromStorage(deps)).sidebarRowItems).toEqual(sidebarRowItems);
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
    expect(result.uiBaseFontSize).toBe(DEFAULT_UI_BASE_FONT_SIZE);
    expect(result.contentFontSize).toBe(DEFAULT_UI_BASE_FONT_SIZE);
    expect(result.codeFontSize).toBe(DEFAULT_CODE_FONT_SIZE);
    expect(result.syntaxTheme).toBe("one");
    expect(result.toolCallDetailLevel).toBe("detailed");
  });

  it("migrates the enabled compact tool call preference to overview", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ compactToolCalls: true }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).toolCallDetailLevel).toBe("overview");
  });

  it("clears settings with an unrecognized tool call detail level", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ toolCallDetailLevel: "unknown" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).toolCallDetailLevel).toBe("detailed");
  });

  it("migrates a switched-off checks row item to the hidden checks display", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sidebarRowItems: { checks: false } }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).sidebarChecksDisplay).toBe("none");
  });

  it("lets a stored checks display win over the row item it replaced", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          sidebarChecksDisplay: "icon",
          sidebarRowItems: { checks: false },
        }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).sidebarChecksDisplay).toBe("icon");
  });

  it("uses a 15px mobile base and a 14px web base", () => {
    expect(defaultUiBaseFontSize(true)).toBe(15);
    expect(defaultUiBaseFontSize(false)).toBe(14);
  });

  it("uses a 15px content default on mobile and web", () => {
    expect(defaultContentFontSize(true)).toBe(15);
    expect(defaultContentFontSize(false)).toBe(15);
    expect(DEFAULT_CONTENT_FONT_SIZE).toBe(defaultContentFontSize(false));
  });

  it("derives and persists content size from an existing interface-size preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);
    const persisted = JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null");

    expect(result.contentFontSize).toBe(17);
    expect(persisted).toMatchObject({ uiBaseFontSize: 17, contentFontSize: 17 });
  });

  it("clamps the content font size into range and rejects non-numeric values", async () => {
    const high = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(high)).contentFontSize).toBe(21);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).contentFontSize).toBe(10);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).contentFontSize).toBe(
      DEFAULT_CONTENT_FONT_SIZE,
    );
  });

  it.each([
    { legacySize: 16, baseSize: 14 },
    { legacySize: 17, baseSize: 15 },
    { legacySize: 18, baseSize: 16 },
  ])(
    "migrates legacy interface size $legacySize to base size $baseSize",
    async ({ legacySize, baseSize }) => {
      const deps = makeDeps({
        storage: createInMemoryKeyValueStorage({
          [APP_SETTINGS_KEY]: JSON.stringify({ uiFontSize: legacySize }),
        }),
      });

      const result = await loadAppSettingsFromStorage(deps);
      const persisted = JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null");

      expect(result.uiBaseFontSize).toBe(baseSize);
      expect(persisted).toMatchObject({ uiBaseFontSize: baseSize });
      expect(persisted).not.toHaveProperty("uiFontSize");
    },
  );

  it("lets an explicit base size win over the legacy interface scale", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 16, uiFontSize: 17 }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiBaseFontSize).toBe(16);
  });

  it("clamps the UI base font size into range and rejects non-numeric values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).uiBaseFontSize).toBe(21);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).uiBaseFontSize).toBe(10);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).uiBaseFontSize).toBe(
      DEFAULT_UI_BASE_FONT_SIZE,
    );
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
