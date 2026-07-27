import { beforeEach, describe, expect, it, vi } from "vitest";

const unistylesMocks = vi.hoisted(() => ({
  setAdaptiveThemes: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  UnistylesRuntime: {
    setAdaptiveThemes: unistylesMocks.setAdaptiveThemes,
    setTheme: unistylesMocks.setTheme,
  },
}));

import { applyThemeSetting, isAppThemeSetting } from "./apply-theme-setting";

describe("isAppThemeSetting", () => {
  it("accepts auto and named themes", () => {
    expect(isAppThemeSetting("auto")).toBe(true);
    expect(isAppThemeSetting("dark")).toBe(true);
    expect(isAppThemeSetting("ghostty")).toBe(true);
    expect(isAppThemeSetting("deepspace")).toBe(true);
    expect(isAppThemeSetting("nope")).toBe(false);
    expect(isAppThemeSetting(null)).toBe(false);
  });
});

describe("applyThemeSetting", () => {
  beforeEach(() => {
    unistylesMocks.setAdaptiveThemes.mockClear();
    unistylesMocks.setTheme.mockClear();
  });

  it("enables adaptive themes for auto", () => {
    applyThemeSetting("auto");
    expect(unistylesMocks.setAdaptiveThemes).toHaveBeenCalledWith(true);
    expect(unistylesMocks.setTheme).not.toHaveBeenCalled();
  });

  it("pins a named Unistyles theme", () => {
    applyThemeSetting("zinc");
    expect(unistylesMocks.setAdaptiveThemes).toHaveBeenCalledWith(false);
    expect(unistylesMocks.setTheme).toHaveBeenCalledWith("darkZinc");
  });
});
