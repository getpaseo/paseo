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

  it("uses Paseo's warm accent with dark button text", () => {
    expect(darkPureBlackTheme.colors.accent).toBe("#cca694");
    expect(darkPureBlackTheme.colors.accentBright).toBe("#dbb7a6");
    expect(darkPureBlackTheme.colors.accentForeground).toBe("#18181b");
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
    expect(lightTheme.colors.surfaceSidebar).toBe("#eff0f3");
    expect(lightTheme.colors.surfaceSidebarHover).toBe(lightTheme.colors.surface1);
    expect(lightTheme.colors.surfaceSidebarSelected).toBe("#e2e4e9");
    expect(lightTheme.colors.surfaceSidebarSelected).not.toBe(lightTheme.colors.surfaceSidebar);
    expect(lightTheme.colors.surfaceWorkspaceChrome).toBe(lightTheme.colors.surfaceSidebar);
    expect(lightTheme.workspaceFrame).toMatchObject({ inset: 12, radius: 20, dividerWidth: 0 });
    expect(lightTheme.borderRadius["2xl"]).toBe(22);
    expect(lightTheme.shadow.composer.shadowOpacity).toBe(1);
  });

  it("derives Dark hover and selection from the first two raised surfaces", () => {
    expect(darkTheme.colors.surfaceSidebarHover).toBe(darkTheme.colors.surface1);
    expect(darkTheme.colors.surfaceSidebarSelected).toBe(darkTheme.colors.surface2);
    expect(darkTheme.workspaceFrame).toMatchObject({ inset: 0, radius: 0, dividerWidth: 1 });
    expect(darkTheme.shadow.composer.shadowOpacity).toBe(0);
  });
});

describe("Built-in light theme", () => {
  it("preserves its authored aliases and terminal contrast through the semantic builder", () => {
    expect(lightTheme.colors).toMatchObject({
      primary: "#18181b",
      primaryForeground: "#fafafa",
      destructiveForeground: "#fcfcfd",
      successForeground: "#fcfcfd",
      terminal: {
        black: "#1a1a1e",
        brightBlack: "#3f3f46",
      },
    });
  });

  it("keeps success semantic and the accent readable", () => {
    expect(lightTheme.colors.accent).toBe("#cca694");
    expect(lightTheme.colors.accentForeground).toBe("#1a1a1e");
    expect(lightTheme.colors.success).toBe(lightTheme.colors.statusSuccess);
    expect(darkTheme.colors.success).toBe(darkTheme.colors.statusSuccess);
  });
});

describe("Composer plan surface", () => {
  it("provides plan colors in both built-in appearances", () => {
    expect(lightTheme.colors.composerInputBackground).toBe("#f9f9f8");
    expect(lightTheme.colors.composerInputBorder).toBe("#e7e4e2");
    expect(lightTheme.colors.composerPlanBackground).toBe("#F5EFED");
    expect(lightTheme.colors.composerPlanStripe).toBe("#EBDDD8");
    expect(lightTheme.colors.composerPlanBorder).toBe("#e2dbd6");
    expect(darkTheme.colors.composerPlanBackground).toBe("#2B2522");
    expect(darkTheme.colors.composerPlanStripe).toBe("#413732");
    expect(darkTheme.colors.composerPlanBorder).toBe("#5A463C");
  });
});
