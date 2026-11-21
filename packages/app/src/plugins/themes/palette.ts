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
import {
  deriveNeutralFills,
  deriveTertiaryText,
  deriveSurfaceStates,
  deriveSidebarStateText,
} from "@/styles/derive-colors";

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
  sidebar: hexColorSchema.optional(),
  sidebarHover: hexColorSchema.optional(),
  sidebarSelected: hexColorSchema.optional(),
  surface3: hexColorSchema.optional(),
  surface4: hexColorSchema.optional(),
  foregroundExtraMuted: hexColorSchema.optional(),
});

// A plugin can contribute a translated name; the catalog resolves it for the app's locale.
const pluginContributionSchema: z.ZodType<PluginThemeContribution<PluginText>> = z.strictObject({
  id: z.string(),
  name: z.union([themeNameSchema, z.custom<PluginMessage>(isPluginMessage)]),
  appearance: z.enum(["light", "dark"]),
  colors: themeColorsSchema,
});

// A snapshot keeps the name resolved when it was taken. A translated name has no length limit and
// is not trimmed, so the stored text is not checked against the plain name's rules.
const contributionSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: z.string(),
  appearance: z.enum(["light", "dark"]),
  colors: themeColorsSchema,
});

export function parsePluginThemeContribution(value: unknown): PluginThemeContribution<PluginText> {
  return pluginContributionSchema.parse(value);
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
  const fills = deriveNeutralFills(colors.background, colors.foreground, "dark");
  const sidebar = colors.sidebar ?? colors.background;
  const states = deriveSurfaceStates(sidebar, colors.foreground, "dark");
  const hover = colors.sidebarHover ?? states.hover;
  const selected = colors.sidebarSelected ?? states.selected;
  const tertiary =
    colors.foregroundExtraMuted ?? deriveTertiaryText(colors.mutedForeground, colors.background);
  return buildDarkTheme(
    buildDarkSemanticColors({
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.surface3 ?? fills.surface3,
      surface4: colors.surface4 ?? fills.surface4,
      surfaceSidebar: sidebar,
      surfaceSidebarHover: hover,
      surfaceSidebarSelected: selected,
      foregroundSidebarHover:
        colors.foregroundExtraMuted ?? deriveSidebarStateText(tertiary, hover, colors.foreground),
      foregroundSidebarSelected:
        colors.foregroundExtraMuted ??
        deriveSidebarStateText(tertiary, selected, colors.foreground),
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: tertiary,
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
  const fills = deriveNeutralFills(colors.background, colors.foreground, "light");
  const sidebar = colors.sidebar ?? colors.control;
  const states = deriveSurfaceStates(sidebar, colors.foreground, "light");
  const hover = colors.sidebarHover ?? states.hover;
  const selected = colors.sidebarSelected ?? states.selected;
  const tertiary =
    colors.foregroundExtraMuted ?? deriveTertiaryText(colors.mutedForeground, colors.background);
  return buildLightTheme(
    buildLightSemanticColors({
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.surface3 ?? fills.surface3,
      surface4: colors.surface4 ?? fills.surface4,
      surfaceSidebar: sidebar,
      surfaceSidebarHover: hover,
      surfaceSidebarSelected: selected,
      foregroundSidebarHover:
        colors.foregroundExtraMuted ?? deriveSidebarStateText(tertiary, hover, colors.foreground),
      foregroundSidebarSelected:
        colors.foregroundExtraMuted ??
        deriveSidebarStateText(tertiary, selected, colors.foreground),
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: tertiary,
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
