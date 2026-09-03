import { describe, expect, it } from "vitest";
import {
  darkPureBlackTheme,
  darkTheme,
  FONT_SIZE,
  getNextThemePreference,
  lightTheme,
  THEME_OPTIONS,
} from "./theme";

describe("Typography scale", () => {
  it("names 14px as the default interface tier", () => {
    expect(FONT_SIZE).toEqual({
      code: 12,
      content: 15,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    });
  });
});

describe("Theme catalog", () => {
  it("owns the picker and shortcut order", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "light",
      "dark",
      "auto",
      "zinc",
      "midnight",
      "claude",
      "ghostty",
      "pureBlack",
    ]);
    expect(getNextThemePreference("dark")).toBe("auto");
    expect(getNextThemePreference("pureBlack")).toBe("light");
  });
});

describe("Pure black theme", () => {
  it("uses a pure black application and terminal background", () => {
    expect(darkPureBlackTheme.colors.surface0).toBe("#000000");
    expect(darkPureBlackTheme.colors.background).toBe("#000000");
    expect(darkPureBlackTheme.colors.terminal.background).toBe("#000000");
  });

  it("uses Paseo's muted green accent", () => {
    expect(darkPureBlackTheme.colors.accent).toBe("#20744A");
    expect(darkPureBlackTheme.colors.accentBright).toBe("#7ccba0");
  });

  it("derives sidebar interaction surfaces from the surface scale", () => {
    expect(darkPureBlackTheme.colors.surfaceSidebar).toBe("#000000");
    expect(darkPureBlackTheme.colors.surfaceSidebarHover).toBe(darkPureBlackTheme.colors.surface1);
    expect(darkPureBlackTheme.colors.surfaceSidebarSelected).toBe(
      darkPureBlackTheme.colors.surface2,
    );
  });

  it("keeps ANSI black output readable on its zero-luminance terminal background", () => {
    expect(darkPureBlackTheme.colors.terminal.black).toBe("#595959");
    expect(darkPureBlackTheme.colors.terminal.brightBlack).toBe("#8a8a8a");
  });
});

describe("Sidebar interaction surfaces", () => {
  it("keeps Light selection distinct from the sidebar surface", () => {
    expect(lightTheme.colors.surfaceSidebarHover).toBe(lightTheme.colors.surface1);
    expect(lightTheme.colors.surfaceSidebarSelected).toBe(lightTheme.colors.surface3);
    expect(lightTheme.colors.surfaceSidebarSelected).not.toBe(lightTheme.colors.surfaceSidebar);
  });

  it("derives Dark hover and selection from the first two raised surfaces", () => {
    expect(darkTheme.colors.surfaceSidebarHover).toBe(darkTheme.colors.surface1);
    expect(darkTheme.colors.surfaceSidebarSelected).toBe(darkTheme.colors.surface2);
  });
});

describe("Built-in light theme", () => {
  it("preserves its authored aliases and terminal contrast through the semantic builder", () => {
    expect(lightTheme.colors).toMatchObject({
      primary: "#18181b",
      primaryForeground: "#fafafa",
      destructiveForeground: "#ffffff",
      successForeground: "#ffffff",
      terminal: {
        black: "#1a1a1e",
        brightBlack: "#3f3f46",
      },
    });
  });
});

describe("Find match colors", () => {
  it("keeps the DOM marks translucent so the text under them stays readable", () => {
    expect(lightTheme.colors.findMatch).toBe("rgba(245, 158, 11, 0.4)");
    expect(lightTheme.colors.findMatchActive).toBe("rgba(249, 115, 22, 0.6)");
    expect(darkTheme.colors.findMatch).toBe("rgba(251, 191, 36, 0.35)");
    expect(darkTheme.colors.findMatchActive).toBe("rgba(249, 115, 22, 0.65)");
  });

  // xterm masks the alpha channel of decoration backgrounds, so the terminal marks are
  // the same palette entries pre-blended onto the terminal background.
  it("pre-blends the terminal marks onto the terminal background", () => {
    expect(lightTheme.colors.terminal.findMatch).toBe("#fbd89d");
    expect(lightTheme.colors.terminal.findMatchActive).toBe("#fbab73");
    expect(darkPureBlackTheme.colors.terminal.findMatch).toBe("#58430d");
    expect(darkPureBlackTheme.colors.terminal.findMatchActive).toBe("#a24b0e");
  });

  it("gives every built-in theme opaque terminal marks", () => {
    for (const theme of [lightTheme, darkTheme, darkPureBlackTheme]) {
      expect(theme.colors.terminal.findMatch).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.colors.terminal.findMatchActive).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
