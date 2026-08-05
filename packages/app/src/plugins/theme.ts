import { UnistylesRuntime } from "react-native-unistyles";
import type { PluginThemeTokens } from "./bridge";

/**
 * Resolved tokens sent to a plugin with `init`. Deliberately a flat handful:
 * plugins style themselves with plain CSS, so anything richer than colours, a
 * font stack, and a base size would just be surface area to keep compatible.
 */
export function resolvePluginThemeTokens(): PluginThemeTokens {
  const theme = UnistylesRuntime.getTheme();
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
