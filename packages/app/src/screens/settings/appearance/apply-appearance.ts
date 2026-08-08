import { UnistylesRuntime, type UnistylesThemes } from "react-native-unistyles";
import { resolveSyntaxColors, type SyntaxThemeId } from "@getpaseo/highlight";
import {
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  FONT_SIZE,
  type Theme,
} from "@/styles/theme";
import { applyRootUiFont } from "./apply-root-font";

// All six registered Unistyles keys — pinned literal (greppable, type-checked).
// The `as const` element types are exactly `keyof UnistylesThemes`, so each key
// is assignable to `UnistylesRuntime.updateTheme`'s first argument with no cast.
const ALL_THEME_KEYS = [
  "light",
  "dark",
  "darkZinc",
  "darkMidnight",
  "darkClaude",
  "darkGhostty",
  "darkAmoled",
  "catppuccinLatte",
  "catppuccinFrappe",
  "catppuccinMacchiato",
  "catppuccinMocha",
] as const;

// The UI font size at which the FONT_SIZE ramp is authored (1.0 scale factor).
const BASE_UI_REFERENCE = FONT_SIZE.base; // 16

export interface AppearanceInput {
  uiFontFamily: string; // "" -> default stack
  monoFontFamily: string; // "" -> default stack
  uiFontSize: number; // already clamped
  codeFontSize: number; // already clamped
  syntaxTheme: SyntaxThemeId;
}

/**
 * Build the font-size ramp from the canonical `FONT_SIZE` ramp, scaled
 * proportionally by `uiSize / 16` so the type hierarchy is preserved at non-default
 * sizes. Deriving from the authored ramp — NOT the live (possibly already-scaled)
 * theme — makes `applyAppearance` idempotent: repeated applies never compound, and a
 * code-size change (uiSize unchanged) leaves the UI ramp at its authored values.
 * `code` is set absolutely to `codeSize`, never scaled by the UI factor — a separate
 * control on a separate semantic axis (mono/diff text).
 */
function scaleFontSize(uiSize: number, codeSize: number): Theme["fontSize"] {
  const r = uiSize / BASE_UI_REFERENCE;
  return {
    xs: Math.round(FONT_SIZE.xs * r),
    sm: Math.round(FONT_SIZE.sm * r),
    base: Math.round(FONT_SIZE.base * r),
    lg: Math.round(FONT_SIZE.lg * r),
    xl: Math.round(FONT_SIZE.xl * r),
    "2xl": Math.round(FONT_SIZE["2xl"] * r),
    "3xl": Math.round(FONT_SIZE["3xl"] * r),
    "4xl": Math.round(FONT_SIZE["4xl"] * r),
    code: codeSize, // absolute, NOT scaled
  };
}

/**
 * Patch every registered Unistyles theme with the user's appearance choices.
 * All keys in `ALL_THEME_KEYS` are patched because the active theme can change
 * and adaptive mode can flip light/dark — patching all keys keeps the active key
 * always current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant.
 *
 * The updater is `(currentTheme: AppTheme) => AppTheme`. We want to preserve the
 * active theme wholesale (surfaces, accents, terminal) and only patch the font
 * ramp and the syntax palette. `updateTheme` replaces the stored theme rather
 * than merging, so we spread `...t` first.
 */
export function applyAppearance(input: AppearanceInput): void {
  const ui = input.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const mono = input.monoFontFamily.trim() || DEFAULT_MONO_FONT_STACK;
  const diffLineHeight = Math.round(input.codeFontSize * 1.5); // couple to code size

  // `UnistylesThemes` is augmented in `@/styles/unistyles` to include every
  // registered key, so this collapses to the full theme union (all variants,
  // both light and dark). A spread of the union widens leaf literals (e.g.
  // `terminal.red` differs across the light themes) into unions that no single
  // member accepts, so no matter what theme `t` is, the returned object is only
  // “assignable back to the union” via a typed cast. The cast is honest — the
  // object is `t` with two fields replaced — and robust as new themes are added.
  type AppTheme = UnistylesThemes[keyof UnistylesThemes];
  for (const key of ALL_THEME_KEYS) {
    UnistylesRuntime.updateTheme(key, (t) => {
      const fontFamily = { ui, mono };
      const fontSize = scaleFontSize(input.uiFontSize, input.codeFontSize);
      const lineHeight = { ...t.lineHeight, diff: diffLineHeight };
      return {
        ...t,
        fontFamily,
        fontSize,
        lineHeight,
        colors: { ...t.colors, syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme) },
      } as AppTheme;
    });
  }

  // Web: apply the UI font app-wide (RN-web stamps a default font on every text
  // element, so it can't be done through the theme alone). No-op on native.
  applyRootUiFont(ui);
}
