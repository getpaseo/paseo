import { UnistylesRuntime } from "react-native-unistyles";
import { resolveSyntaxColors, type SyntaxThemeId } from "@getpaseo/highlight";
import {
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  FONT_SIZE,
  type Theme,
} from "@/styles/theme";

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
 * Scale the entire UI ramp proportionally by `uiSize / 16`, rounding each step,
 * so the type hierarchy is preserved at non-default sizes. `code` is set
 * absolutely to `codeSize` and is never scaled by the UI factor — it is a
 * separate control on a separate semantic axis (mono/diff text).
 */
function scaleFontSize(
  base: Theme["fontSize"],
  uiSize: number,
  codeSize: number,
): Theme["fontSize"] {
  const r = uiSize / BASE_UI_REFERENCE;
  return {
    xs: Math.round(base.xs * r),
    sm: Math.round(base.sm * r),
    base: Math.round(base.base * r),
    lg: Math.round(base.lg * r),
    xl: Math.round(base.xl * r),
    "2xl": Math.round(base["2xl"] * r),
    "3xl": Math.round(base["3xl"] * r),
    "4xl": Math.round(base["4xl"] * r),
    code: codeSize, // absolute, NOT scaled
  };
}

/**
 * Patch every registered Unistyles theme with the user's appearance choices.
 * All six keys are patched because the active theme can change and adaptive mode
 * can flip light/dark — patching all keys keeps the active key always current and
 * makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant.
 */
export function applyAppearance(input: AppearanceInput): void {
  const ui = input.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const mono = input.monoFontFamily.trim() || DEFAULT_MONO_FONT_STACK;
  const diffLineHeight = Math.round(input.codeFontSize * 1.5); // couple to code size

  for (const key of ALL_THEME_KEYS) {
    // Spread `...t` first — `updateTheme` replaces the stored theme, it does not
    // merge; an omitted key would be dropped. `syntax` follows the theme's own
    // scheme for `auto`; named palettes ignore it. `colors.base`/plain text stays
    // `theme.colors.foreground` (owned by `syntaxTokenStyles.base`, not patched).
    //
    // Narrow on the `colorScheme` discriminant before spreading: the updater must
    // return the theme union, and a spread of the union widens `colorScheme` to
    // `"light" | "dark"`, assignable to neither concrete member. Each branch spreads
    // a single narrowed theme type.
    UnistylesRuntime.updateTheme(key, (t) => {
      const fontFamily = { ui, mono };
      const fontSize = scaleFontSize(t.fontSize, input.uiFontSize, input.codeFontSize);
      const lineHeight = { ...t.lineHeight, diff: diffLineHeight };
      if (t.colorScheme === "light") {
        return {
          ...t,
          fontFamily,
          fontSize,
          lineHeight,
          colors: { ...t.colors, syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme) },
        };
      }
      return {
        ...t,
        fontFamily,
        fontSize,
        lineHeight,
        colors: { ...t.colors, syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme) },
      };
    });
  }
}
