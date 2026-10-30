import type { PluginMessage } from "@getpaseo/plugin/client";
import { isPluginMessage } from "@getpaseo/plugin/client/host";
import { useMemo } from "react";
import { z } from "zod";
import type { PluginThemeContribution } from "../types";
import { useHostFeatureMap } from "@/runtime/host-features";
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
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "../contribution-host";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";

const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Must be a hex color");

const radiusSchema = z.number().min(0).max(9999);
const paddingSchema = z.number().min(0).max(48);
const fontWeightSchema = z.enum(["400", "500", "600"]);
const rowStyleSchema = z.strictObject({
  minHeight: z.number().min(24).max(96).optional(),
  paddingHorizontal: paddingSchema.optional(),
  paddingVertical: paddingSchema.optional(),
  radius: radiusSchema.optional(),
  gap: z.number().min(0).max(32).optional(),
  fontWeight: fontWeightSchema.optional(),
});
const buttonSizeSchema = z.strictObject({
  minHeight: z.number().min(24).max(96).optional(),
  paddingHorizontal: paddingSchema.optional(),
});
const componentStylesSchema = z.strictObject({
  button: z
    .strictObject({
      radius: radiusSchema.optional(),
      borderWidth: z.number().min(0).max(4).optional(),
      fontWeight: fontWeightSchema.optional(),
      hoverOpacity: z.number().min(0.3).max(1).optional(),
      pressedOpacity: z.number().min(0.3).max(1).optional(),
      pressedScale: z.number().min(0.9).max(1).optional(),
      sizes: z
        .strictObject({
          xs: buttonSizeSchema.optional(),
          sm: buttonSizeSchema.optional(),
          md: buttonSizeSchema.optional(),
          lg: buttonSizeSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  iconButton: z
    .strictObject({
      radius: radiusSchema.optional(),
      highlightColor: hexColorSchema.optional(),
    })
    .optional(),
  sidebar: z
    .strictObject({
      projectRow: rowStyleSchema.optional(),
      workspaceRow: rowStyleSchema.optional(),
      workspaceIndent: z.number().min(0).max(48).optional(),
      groupGap: z.number().min(0).max(48).optional(),
    })
    .optional(),
  projectIcon: z
    .strictObject({
      size: z.number().min(12).max(32).optional(),
      radius: radiusSchema.optional(),
      background: hexColorSchema.optional(),
      foreground: hexColorSchema.optional(),
      borderColor: hexColorSchema.optional(),
      borderWidth: z.number().min(0).max(4).optional(),
    })
    .optional(),
  statusIndicator: z
    .strictObject({
      size: z.number().min(4).max(16).optional(),
      runningStyle: z.enum(["ring", "dot"]).optional(),
      animation: z.enum(["default", "none"]).optional(),
      colors: z
        .strictObject({
          running: hexColorSchema.optional(),
          needsInput: hexColorSchema.optional(),
          failed: hexColorSchema.optional(),
          attention: hexColorSchema.optional(),
          inactive: hexColorSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

const contributionSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(),
  name: z.union([z.string().trim().min(1).max(60), z.custom<PluginMessage>(isPluginMessage)]),
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
  components: componentStylesSchema.optional(),
});

export interface PluginThemeOption {
  id: string;
  serverId: string;
  name: string;
  swatch: string;
  theme: Theme;
}

interface PluginThemeTarget {
  serverId: string;
  contribution: PluginThemeContribution;
  plugin: InstalledPlugin;
}

export function parsePluginThemeContribution(value: unknown): PluginThemeContribution {
  return contributionSchema.parse(value);
}

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

function buildPluginTheme(contribution: PluginThemeContribution): Theme {
  const theme =
    contribution.appearance === "light"
      ? buildLightPluginTheme(contribution)
      : buildDarkPluginTheme(contribution);
  // Rebuild from the built-in defaults on every catalog update. A removed override must not
  // survive a plugin reload or a switch to another theme in the same reserved slot.
  const components = contribution.components;
  return {
    ...theme,
    components: {
      button: components?.button ?? theme.components.button,
      iconButton: components?.iconButton ?? theme.components.iconButton,
      sidebar: components?.sidebar ?? theme.components.sidebar,
      projectIcon: components?.projectIcon ?? theme.components.projectIcon,
      statusIndicator: components?.statusIndicator ?? theme.components.statusIndicator,
    },
  };
}

function selectTarget(id: string, targets: PluginThemeTarget[]): PluginThemeTarget {
  const preferredHost = getPreferredPluginContributionHost(id);
  return targets.find((target) => target.serverId === preferredHost) ?? targets[0];
}

export function collectPluginThemes(
  plugins: InstalledPlugin[],
  supportedHosts: ReadonlySet<string>,
): PluginThemeOption[] {
  const targetsById = new Map<string, PluginThemeTarget[]>();
  for (const plugin of plugins) {
    if (!supportedHosts.has(plugin.serverId)) continue;
    for (const contribution of plugin.themes) {
      const id = `${plugin.id}/theme/${contribution.id}`;
      const target = { serverId: plugin.serverId, contribution, plugin };
      const targets = targetsById.get(id);
      if (targets) targets.push(target);
      else targetsById.set(id, [target]);
    }
  }

  return [...targetsById].map(([id, targets]) => {
    const target = selectTarget(id, targets);
    return {
      id,
      serverId: target.serverId,
      name: target.plugin.i18n.resolve(target.contribution.name, target.plugin.locale),
      swatch: target.contribution.colors.background,
      theme: buildPluginTheme(target.contribution),
    };
  });
}

export function rememberPluginThemeHost(option: PluginThemeOption): void {
  rememberPluginContributionHost(option.id, option.serverId);
}

function supportedThemeHosts(support: ReadonlyMap<string, boolean>): Set<string> {
  const serverIds = new Set<string>();
  for (const [serverId, supported] of support) {
    if (supported) serverIds.add(serverId);
  }
  return serverIds;
}

export function usePluginThemeCatalog(): PluginThemeOption[] {
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
