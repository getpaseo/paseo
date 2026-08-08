import { describe, expect, it } from "vitest";
import { darkGhosttyTheme, darkTheme, darkZincTheme, lightTheme } from "@/styles/theme";
import { resolvePluginThemeTokens } from "./theme";

describe("resolvePluginThemeTokens", () => {
  it("reports the colour scheme of the theme it is given", () => {
    expect(resolvePluginThemeTokens(lightTheme).colorScheme).toBe("light");
    expect(resolvePluginThemeTokens(darkTheme).colorScheme).toBe("dark");
  });

  // The app theme is user-selectable independently of the OS colour scheme, so
  // the dark variants must not collapse onto one palette.
  it("distinguishes the dark variants from each other", () => {
    const palettes = [darkTheme, darkZincTheme, darkGhosttyTheme].map(
      (theme) => resolvePluginThemeTokens(theme).background,
    );
    expect(new Set(palettes).size).toBe(palettes.length);
  });

  it("carries the font stack the theme was patched with", () => {
    const patched = {
      ...darkTheme,
      fontFamily: { ...darkTheme.fontFamily, ui: "Patched UI", mono: "Patched Mono" },
    };
    expect(resolvePluginThemeTokens(patched)).toMatchObject({
      fontFamily: "Patched UI",
      monoFontFamily: "Patched Mono",
    });
  });
});
