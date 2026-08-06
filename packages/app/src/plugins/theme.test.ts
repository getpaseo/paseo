import { readFileSync } from "node:fs";
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

/**
 * The regression this replaces derived tokens from `useColorScheme()` plus a
 * static `darkTheme` import. That is invisible to every assertion above — the
 * function was already correct — so the guard has to be on where the theme
 * comes from. `withUnistyles` is the only sanctioned source (docs/unistyles.md).
 */
describe("sandbox theming", () => {
  const SANDBOXES = ["src/plugins/sandbox.tsx", "src/plugins/sandbox.web.tsx"];

  it("takes the theme from withUnistyles, not a static import or the banned hook", () => {
    for (const file of SANDBOXES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("withUnistyles(PluginSandboxView");
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""), file).not.toContain("useUnistyles(");
      expect(source, file).not.toMatch(/from "@\/styles\/theme"/);
    }
  });

  it("does not let the token resolver reach for a theme itself", () => {
    const source = readFileSync("src/plugins/theme.ts", "utf8");
    expect(source).toMatch(/import type \{ Theme \} from "@\/styles\/theme"/);
    expect(source).not.toMatch(/^import \{[^}]*Theme[^}]*\} from "@\/styles\/theme"/m);
  });
});
