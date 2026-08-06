import type { Theme } from "@/styles/theme";
import type { PluginSandboxProps, PluginThemeTokens } from "./bridge";

/** What each platform's sandbox actually renders, once `withUnistyles` has injected the theme. */
export type ThemedPluginSandboxProps = PluginSandboxProps & { themeTokens: PluginThemeTokens };

/**
 * Resolved tokens sent to a plugin with `init` and again with every `update`.
 * Deliberately a flat handful: plugins style themselves with plain CSS, so
 * anything richer than colours, a font stack, and a base size would just be
 * surface area to keep compatible.
 *
 * Feed this the *live* Unistyles theme via `withUnistyles`, never a static
 * import. The app theme is user-selectable (`auto|light|dark|zinc|midnight|
 * claude|ghostty`, see `app/_layout.tsx`) and `apply-appearance.ts` patches
 * fonts through `UnistylesRuntime.updateTheme`, so the OS colour scheme alone
 * gets both the palette and the fonts wrong.
 */
export function resolvePluginThemeTokens(theme: Theme): PluginThemeTokens {
  return {
    colorScheme: theme.colorScheme === "light" ? "light" : "dark",
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    accent: theme.colors.accent,
    fontFamily: theme.fontFamily.ui,
    monoFontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  };
}
