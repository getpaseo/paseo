import { useMemo } from "react";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { darkTheme, lightTheme } from "@/styles/theme";
import type { PluginThemeTokens } from "./bridge";

type AppTheme = typeof lightTheme | typeof darkTheme;

/**
 * Resolved tokens sent to a plugin with `init` and again with every `update`.
 * Deliberately a flat handful: plugins style themselves with plain CSS, so
 * anything richer than colours, a font stack, and a base size would just be
 * surface area to keep compatible.
 */
export function resolvePluginThemeTokens(theme: AppTheme): PluginThemeTokens {
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

/**
 * Reactive so a light/dark switch reaches a live plugin — a plain
 * `UnistylesRuntime` read does not re-render (docs/unistyles.md).
 *
 * Deliberately not `useUnistyles()`, which docs/unistyles.md bans outright.
 * The themes are configured with `adaptiveThemes: true` and nothing calls
 * `setTheme`, so the active theme is a function of the OS colour scheme and
 * React Native's own reactive hook plus a static theme import gets there
 * without subscribing this subtree to every runtime change.
 *
 * ponytail: the tokens collapse the darkZinc/darkMidnight/darkClaude/darkGhostty
 * variants onto plain dark. Select on the real theme name if those ever become
 * user-selectable.
 */
export function usePluginThemeTokens(): PluginThemeTokens {
  const colorScheme = useColorScheme();
  return useMemo(
    () => resolvePluginThemeTokens(colorScheme === "light" ? lightTheme : darkTheme),
    [colorScheme],
  );
}
