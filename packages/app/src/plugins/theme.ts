import type { PluginTheme } from "@getpaseo/plugin";
import type { Theme } from "@/styles/theme";
import { hexColorWithAlpha } from "@/utils/color";

export function toPluginTheme(theme: Theme, breakpoint: string | undefined): PluginTheme {
  const compact = breakpoint === "xs" || breakpoint === "sm";
  return {
    colors: {
      surface0: theme.colors.surface0,
      surface1: theme.colors.surface1,
      surface2: theme.colors.surface2,
      border: theme.colors.border,
      scrim: compact ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.55)",
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      accentForeground: theme.colors.accentForeground,
      statusSuccess: theme.colors.statusSuccess,
      statusWarning: theme.colors.statusWarning,
      statusDanger: theme.colors.statusDanger,
      statusDangerTint: hexColorWithAlpha(theme.colors.statusDanger, 0.1),
    },
  };
}
