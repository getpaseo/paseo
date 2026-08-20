import { useMemo } from "react";
import { z } from "zod";
import type { PluginTheme, PluginThemeContribution } from "@getpaseo/plugin";
import { useHostFeatureMap } from "@/runtime/host-features";
import { buildDarkSemanticColors, buildDarkTheme, darkTheme, type Theme } from "@/styles/theme";
import { useInstalledPlugins } from "./registry";
import type { InstalledPlugin } from "./types";

export function toPluginTheme(theme: Theme): PluginTheme {
  return {
    colors: {
      surface0: theme.colors.surface0,
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      accentForeground: theme.colors.accentForeground,
      statusDanger: theme.colors.statusDanger,
    },
  };
}

const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Must be a hex color");

export const pluginThemeSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: z.string().trim().min(1).max(60),
  appearance: z.literal("dark"),
  colors: z.strictObject({
    background: hexColorSchema,
    foreground: hexColorSchema,
    raised: hexColorSchema,
    control: hexColorSchema,
    accent: hexColorSchema,
    highlight: hexColorSchema.optional(),
    mutedForeground: hexColorSchema,
    ring: hexColorSchema,
  }),
});

/**
 * Expand a contributed palette into a full theme through the same builder every built-in dark
 * variant uses, so a contributed theme picks up new tokens as they are added.
 *
 * `accent` in a contributed palette is the raised/border tint, not the vivid one — the same split
 * the built-in tints use between `surface3`/`border` and `accent`. `highlight` is the vivid color;
 * without it, `foreground` carries the accent so buttons and selections stay legible.
 */
export function buildPluginTheme(contribution: PluginThemeContribution): typeof darkTheme {
  const colors = contribution.colors;
  const highlight = colors.highlight ?? colors.foreground;
  return buildDarkTheme(
    buildDarkSemanticColors({
      surface0: colors.background,
      surface1: colors.raised,
      surface2: colors.control,
      surface3: colors.accent,
      surface4: colors.ring,
      surfaceDiffEmpty: colors.raised,
      surfaceSidebar: colors.background,
      foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground,
      foregroundExtraMuted: colors.ring,
      border: colors.accent,
      borderAccent: colors.accent,
      accent: highlight,
      accentBright: highlight,
      accentForeground: colors.background,
      destructive: darkTheme.colors.destructive,
      terminalBlack: colors.control,
      terminalBrightBlack: colors.ring,
      ring: colors.ring,
    }),
  );
}

export interface PluginThemeOption {
  /** Persisted selection id. Stable across hosts so the same plugin coalesces to one entry. */
  id: string;
  contribution: PluginThemeContribution;
}

export function collectPluginThemes(
  plugins: InstalledPlugin[],
  supportedHosts: ReadonlySet<string>,
): PluginThemeOption[] {
  const options = new Map<string, PluginThemeOption>();
  for (const plugin of plugins) {
    if (!supportedHosts.has(plugin.serverId)) continue;
    for (const contribution of plugin.themes) {
      const id = `${plugin.id}/theme/${contribution.id}`;
      if (!options.has(id)) options.set(id, { id, contribution });
    }
  }
  return [...options.values()];
}

function supportedThemeHosts(support: ReadonlyMap<string, boolean>): Set<string> {
  const serverIds = new Set<string>();
  for (const [serverId, supported] of support) {
    if (supported) serverIds.add(serverId);
  }
  return serverIds;
}

/**
 * The themes on offer, from the hosts that can actually run one. A daemon that predates the
 * `pluginThemes` capability leaves `addTheme` in the server bundle it compiles, so this is the
 * single place the app decides a host's themes are usable.
 */
export function usePluginThemes(): PluginThemeOption[] {
  const plugins = useInstalledPlugins();
  const serverIds = useMemo(
    () => [...new Set(plugins.map((plugin) => plugin.serverId))],
    [plugins],
  );
  // COMPAT(pluginThemes): added in v0.5.0, remove gate after 2027-08-20.
  const support = useHostFeatureMap(serverIds, "pluginThemes");
  return useMemo(
    () => collectPluginThemes(plugins, supportedThemeHosts(support)),
    [plugins, support],
  );
}

/**
 * Returns null when the selected theme is gone — plugin disabled, removed, failed to load, no
 * longer contributing that id, or on a host that cannot run themes. Callers fall back to the
 * default theme rather than an empty slot.
 */
export function findPluginTheme(
  options: PluginThemeOption[],
  id: string | null,
): PluginThemeContribution | null {
  if (id === null) return null;
  return options.find((option) => option.id === id)?.contribution ?? null;
}
