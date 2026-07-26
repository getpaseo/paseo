import { z } from "zod";
import { darkTheme } from "./theme";

const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Must be a hex color");

export const customThemeSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(60),
    appearance: z.literal("dark"),
    colors: z
      .object({
        background: hexColorSchema,
        foreground: hexColorSchema,
        raised: hexColorSchema,
        control: hexColorSchema,
        accent: hexColorSchema,
        highlight: hexColorSchema.optional(),
        mutedForeground: hexColorSchema,
        ring: hexColorSchema,
      })
      .strict(),
  })
  .strict();

export type CustomThemePreset = z.infer<typeof customThemeSchema>;

export function buildCustomTheme(preset: CustomThemePreset) {
  const colors = preset.colors;
  const primaryAccent = colors.highlight ?? colors.foreground;
  return {
    ...darkTheme,
    colors: {
      ...darkTheme.colors,
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.accent,
      surface4: colors.ring,
      surfaceDiffEmpty: colors.raised,
      surfaceSidebar: colors.background,
      surfaceSidebarHover: colors.raised,
      surfaceWorkspace: colors.background,
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: colors.ring,
      scrollbarHandle: colors.ring,
      border: colors.accent,
      borderAccent: colors.accent,
      accent: primaryAccent,
      accentBright: primaryAccent,
      accentForeground: colors.background,
      background: colors.background,
      popover: colors.raised,
      popoverForeground: colors.foreground,
      primary: colors.foreground,
      primaryForeground: colors.background,
      secondary: colors.control,
      secondaryForeground: colors.foreground,
      muted: colors.control,
      mutedForeground: colors.mutedForeground,
      accentBorder: colors.accent,
      input: colors.accent,
      ring: colors.ring,
      terminal: {
        ...darkTheme.colors.terminal,
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.foreground,
        cursorAccent: colors.background,
        selectionForeground: colors.foreground,
        black: colors.background,
        brightBlack: colors.ring,
      },
    },
  };
}

export const DEFAULT_CUSTOM_THEME_PRESET: CustomThemePreset = {
  version: 1,
  name: "Custom",
  appearance: "dark",
  colors: {
    background: "#181B1A",
    foreground: "#fafafa",
    raised: "#1E2120",
    control: "#272A29",
    accent: "#20744A",
    mutedForeground: "#A1A5A4",
    ring: "#717574",
  },
};

export const customTheme = buildCustomTheme(DEFAULT_CUSTOM_THEME_PRESET);
