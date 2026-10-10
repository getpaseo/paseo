import { z } from "zod";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import {
  buildDarkSemanticColors,
  buildDarkTheme,
  buildLightSemanticColors,
  buildLightTheme,
  darkTheme,
  lightTheme,
  type Theme,
} from "@/styles/theme";

// Contributed theme palettes, apart from the catalog: app settings parse a stored snapshot with
// these schemas and must not import the plugin registry to do it.

const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Must be a hex color");

const contributionSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: z.string().trim().min(1).max(60),
  appearance: z.enum(["light", "dark"]),
  colors: z.strictObject({
    background: hexColorSchema,
    foreground: hexColorSchema,
    raised: hexColorSchema,
    control: hexColorSchema,
    border: hexColorSchema,
    accent: hexColorSchema.optional(),
    mutedForeground: hexColorSchema,
    ring: hexColorSchema,
  }),
});

export function parsePluginThemeContribution(value: unknown): PluginThemeContribution {
  return contributionSchema.parse(value);
}

export const pluginThemeSnapshotSchema = z.strictObject({
  id: z.string(),
  serverId: z.string(),
  contribution: contributionSchema,
});

/**
 * The contributed theme last applied, kept in app settings so a start can paint it before any
 * plugin has loaded. `id` is the catalog id, `serverId` the host that contributed it.
 */
export type PluginThemeSnapshot = z.infer<typeof pluginThemeSnapshotSchema>;

function buildDarkPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildDarkTheme(
    buildDarkSemanticColors({
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.border,
      surface4: colors.ring,
      surfaceDiffEmpty: colors.raised,
      surfaceSidebar: colors.background,
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: colors.ring,
      border: colors.border,
      borderAccent: colors.border,
      accent,
      accentBright: accent,
      accentForeground: colors.background,
      destructive: darkTheme.colors.destructive,
      terminalBlack: colors.control,
      terminalBrightBlack: colors.ring,
      ring: colors.ring,
    }),
  );
}

function buildLightPluginTheme(contribution: PluginThemeContribution): Theme {
  const colors = contribution.colors;
  const accent = colors.accent ?? colors.foreground;
  return buildLightTheme(
    buildLightSemanticColors({
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.border,
      surface4: colors.ring,
      surfaceDiffEmpty: colors.raised,
      surfaceSidebar: colors.control,
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: colors.ring,
      border: colors.border,
      borderAccent: colors.border,
      accent,
      accentBright: accent,
      accentForeground: colors.background,
      primary: colors.foreground,
      primaryForeground: colors.background,
      destructive: lightTheme.colors.destructive,
      terminalBlack: colors.foreground,
      terminalBrightBlack: colors.ring,
      ring: colors.ring,
    }),
  );
}

export function buildPluginTheme(contribution: PluginThemeContribution): Theme {
  return contribution.appearance === "light"
    ? buildLightPluginTheme(contribution)
    : buildDarkPluginTheme(contribution);
}
