import { z } from "zod";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginMessage, PluginText } from "@getpaseo/plugin/client";
import { isPluginMessage } from "@getpaseo/plugin/client/host";
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

const themeNameSchema = z.string().trim().min(1).max(60);

const themeColorsSchema = z.strictObject({
  background: hexColorSchema,
  foreground: hexColorSchema,
  raised: hexColorSchema,
  control: hexColorSchema,
  border: hexColorSchema,
  accent: hexColorSchema.optional(),
  mutedForeground: hexColorSchema,
  ring: hexColorSchema,
});

// A plugin can contribute a translated name; the catalog resolves it for the app's locale.
const pluginContributionSchema: z.ZodType<PluginThemeContribution<PluginText>> = z.strictObject({
  id: z.string(),
  name: z.union([themeNameSchema, z.custom<PluginMessage>(isPluginMessage)]),
  appearance: z.enum(["light", "dark"]),
  colors: themeColorsSchema,
});

// A snapshot keeps the name resolved when it was taken.
const contributionSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: themeNameSchema,
  appearance: z.enum(["light", "dark"]),
  colors: themeColorsSchema,
});

export function parsePluginThemeContribution(value: unknown): PluginThemeContribution<PluginText> {
  return pluginContributionSchema.parse(value);
}

/**
 * The contributed theme last applied, kept in app settings so a start can paint it before any
 * plugin has loaded. `id` is the catalog id, `serverId` the host that contributed it.
 */
export interface PluginThemeSnapshot {
  id: string;
  serverId: string;
  contribution: PluginThemeContribution;
}

export const pluginThemeSnapshotSchema: z.ZodType<PluginThemeSnapshot> = z.strictObject({
  id: z.string(),
  serverId: z.string(),
  contribution: contributionSchema,
});

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
