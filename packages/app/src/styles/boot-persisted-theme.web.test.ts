import { beforeEach, describe, expect, it, vi } from "vitest";

const applyMocks = vi.hoisted(() => ({
  applyThemeSetting: vi.fn(),
}));

vi.mock("./apply-theme-setting", () => ({
  applyThemeSetting: applyMocks.applyThemeSetting,
  isAppThemeSetting: (value: unknown) =>
    value === "auto" ||
    value === "light" ||
    value === "dark" ||
    value === "zinc" ||
    value === "midnight" ||
    value === "claude" ||
    value === "ghostty" ||
    value === "deepspace",
}));

import { bootPersistedThemeFromStorage } from "./boot-persisted-theme.web";

describe("bootPersistedThemeFromStorage", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    applyMocks.applyThemeSetting.mockClear();
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    });
  });

  it("applies a named theme from localStorage", () => {
    globalThis.localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "claude" }));
    bootPersistedThemeFromStorage();
    expect(applyMocks.applyThemeSetting).toHaveBeenCalledWith("claude");
  });

  it("ignores missing or invalid storage", () => {
    bootPersistedThemeFromStorage();
    expect(applyMocks.applyThemeSetting).not.toHaveBeenCalled();

    globalThis.localStorage.setItem("@paseo:app-settings", "{");
    bootPersistedThemeFromStorage();
    expect(applyMocks.applyThemeSetting).not.toHaveBeenCalled();

    globalThis.localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "nope" }));
    bootPersistedThemeFromStorage();
    expect(applyMocks.applyThemeSetting).not.toHaveBeenCalled();
  });
});
