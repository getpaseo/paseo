import { UnistylesRuntime } from "react-native-unistyles";
import type { ColorSchemeName } from "react-native";
import { resolveSyntaxColors, type SyntaxThemeId } from "@getpaseo/highlight";
import {
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  FONT_SIZE,
  PLUGIN_THEME_NAMES,
  PLUGIN_THEME_PREFERENCE,
  REGISTERED_THEMES,
  resolveCodeLineHeight,
  resolveContentLineHeight,
  THEME_TO_UNISTYLES,
  type DarkThemePreference,
  type Theme,
  type ThemePreference,
} from "@/styles/theme";
import type { PluginThemeOption } from "@/plugins/themes";
import { DEFAULT_THEME_PREFERENCE } from "@/hooks/use-settings/storage";
import { applyRootUiFont } from "./apply-root-font";
import { applySystemAccentColors } from "./system-accent";

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];

export interface ApplyThemeInput {
  preference: ThemePreference;
  preferredDarkTheme: DarkThemePreference;
  contributedTheme: PluginThemeOption | null;
  systemColorScheme: ColorSchemeName;
}

export function applyTheme(input: ApplyThemeInput): void {
  const contributedTheme = input.contributedTheme;
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    return;
  }

  const builtInPreference =
    input.preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : input.preference;
  UnistylesRuntime.setAdaptiveThemes(false);
  if (builtInPreference === "auto") {
    const themeName =
      input.systemColorScheme === "dark"
        ? THEME_TO_UNISTYLES[input.preferredDarkTheme]
        : THEME_TO_UNISTYLES.light;
    UnistylesRuntime.setTheme(themeName);
    return;
  }

  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

export interface AppearanceInput {
  uiFontFamily: string; // "" -> default stack
  monoFontFamily: string; // "" -> default stack
  uiBaseFontSize: number; // already clamped
  contentFontSize: number; // already clamped
  codeFontSize: number; // already clamped
  contentMaxWidth: number; // already clamped, default resolved
  syntaxTheme: SyntaxThemeId;
  /** macOS system accent. Null keeps each theme's own accent. */
  systemAccent?: string | null;
}

/**
 * Build the font-size ramp from the canonical `FONT_SIZE` ramp, scaled
 * proportionally from the requested base size so the type hierarchy is preserved
 * sizes. Deriving from the authored ramp — NOT the live (possibly already-scaled)
 * theme — makes `applyAppearance` idempotent: repeated applies never compound, and a
 * code-size change (base size unchanged) leaves the UI ramp at its authored values.
 * `code` is set absolutely to `codeSize`, never scaled by the UI factor — a separate
 * control on a separate semantic axis (mono/diff text).
 */
function scaleFontSize(
  uiBaseSize: number,
  contentSize: number,
  codeSize: number,
): Theme["fontSize"] {
  const r = uiBaseSize / FONT_SIZE.base;
  return {
    sm: Math.round(FONT_SIZE.sm * r),
    base: Math.round(FONT_SIZE.base * r),
    lg: Math.round(FONT_SIZE.lg * r),
    xl: Math.round(FONT_SIZE.xl * r),
    "2xl": Math.round(FONT_SIZE["2xl"] * r),
    "3xl": Math.round(FONT_SIZE["3xl"] * r),
    "4xl": Math.round(FONT_SIZE["4xl"] * r),
    content: contentSize, // absolute, NOT scaled
    code: codeSize, // absolute, NOT scaled
  };
}

/**
 * Patch every registered Unistyles theme with the user's appearance choices.
 * All keys in `ALL_THEME_KEYS` are patched because the active theme can change
 * and adaptive mode can flip light/dark — patching all keys keeps the active key
 * always current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant.
 *
 * The updater preserves the active theme wholesale (surfaces, accents,
 * terminal) and only patches the font ramp, content width, and syntax palette.
 * `updateTheme` replaces the stored theme rather than merging, so we spread
 * `...t` first.
 */
export function applyAppearance(input: AppearanceInput): void {
  const ui = input.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const mono = input.monoFontFamily.trim() || DEFAULT_MONO_FONT_STACK;
  const contentLineHeight = resolveContentLineHeight(input.contentFontSize);
  const codeLineHeight = resolveCodeLineHeight(input.codeFontSize);
  const activeTheme = UnistylesRuntime.themeName;
  // Unistyles web emits after each registry patch. Updating the mounted theme
  // first ensures subscribers receive its new numeric tokens in this render;
  // updating it last makes Pure black appear one committed value behind.
  const themeKeys = activeTheme
    ? [activeTheme, ...ALL_THEME_KEYS.filter((key) => key !== activeTheme)]
    : ALL_THEME_KEYS;

  for (const key of themeKeys) {
    UnistylesRuntime.updateTheme(key, (t) => {
      const fontFamily = { ui, mono };
      const fontSize = scaleFontSize(
        input.uiBaseFontSize,
        input.contentFontSize,
        input.codeFontSize,
      );
      const lineHeight = {
        ...t.lineHeight,
        content: contentLineHeight,
        code: codeLineHeight,
        diff: codeLineHeight,
      };
      const syntax = resolveSyntaxColors(input.syntaxTheme, t.colorScheme);
      if (t.colorScheme === "light") {
        const colors = input.systemAccent
          ? applySystemAccentColors({ ...t.colors, syntax }, input.systemAccent, t.colorScheme)
          : { ...t.colors, syntax };
        return {
          ...t,
          fontFamily,
          fontSize,
          lineHeight,
          contentMaxWidth: input.contentMaxWidth,
          colors,
        };
      }
      const colors = input.systemAccent
        ? applySystemAccentColors({ ...t.colors, syntax }, input.systemAccent, t.colorScheme)
        : { ...t.colors, syntax };
      return {
        ...t,
        fontFamily,
        fontSize,
        lineHeight,
        contentMaxWidth: input.contentMaxWidth,
        colors,
      };
    });
  }

  // Web: apply the UI font app-wide (RN-web stamps a default font on every text
  // element, so it can't be done through the theme alone). No-op on native.
  applyRootUiFont(ui);
}
