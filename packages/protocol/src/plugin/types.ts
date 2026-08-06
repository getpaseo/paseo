import { z } from "zod";

/**
 * A plugin id is also its directory name under `$PASEO_HOME/plugins/`, so it is
 * constrained tightly enough that it can never escape that directory.
 */
export const PluginIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,63}$/, "Plugin id must be lowercase letters, digits, and dashes");

/**
 * A contribution entry is one self-contained HTML file sitting directly in the
 * plugin directory. Flat names only: no directories, no traversal, no other
 * asset types. Plugin authors bundle their JS and CSS into the HTML.
 */
export const PluginEntrySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}\.html$/, "Plugin entry must be a flat .html filename");

export const PluginFilePreviewContributionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(64),
  /** Lowercase, dot-prefixed file extensions this preview claims. */
  extensions: z
    .array(
      z
        .string()
        .trim()
        .regex(/^\.[a-z0-9.]{1,16}$/),
    )
    .min(1),
  entry: PluginEntrySchema,
});
export type PluginFilePreviewContribution = z.infer<typeof PluginFilePreviewContributionSchema>;

export const PluginSidebarPanelContributionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(64),
  /**
   * Lucide icon name. Accepted and stored, but every plugin tab currently
   * renders the same generic icon — see docs/plugins.md. Kept so manifests do
   * not have to change if that becomes honoured.
   */
  icon: z.string().trim().min(1).max(64).optional(),
  entry: PluginEntrySchema,
});
export type PluginSidebarPanelContribution = z.infer<typeof PluginSidebarPanelContributionSchema>;

export const PluginContributionsSchema = z.object({
  filePreviews: z.array(PluginFilePreviewContributionSchema).optional(),
  sidebarPanels: z.array(PluginSidebarPanelContributionSchema).optional(),
});
export type PluginContributions = z.infer<typeof PluginContributionsSchema>;

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().trim().min(1).max(96),
  version: z.string().trim().min(1).max(32),
  description: z.string().trim().max(512).optional(),
  author: z.string().trim().max(128).optional(),
  homepage: z.url().optional(),
  license: z.string().trim().max(64).optional(),
  /** Semver range the plugin needs from the daemon, e.g. ">=0.2.6". */
  paseoVersion: z.string().trim().max(64).optional(),
  contributes: PluginContributionsSchema,
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginSourceSchema = z.discriminatedUnion("kind", [
  /** Dropped into `$PASEO_HOME/plugins/` by hand. Never auto-updated. */
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("registry"), registryUrl: z.url() }),
]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const InstalledPluginSchema = z.object({
  manifest: PluginManifestSchema,
  enabled: z.boolean(),
  installedAt: z.string(),
  source: PluginSourceSchema,
  /**
   * Set when the plugin is installed but unusable: unsatisfied `paseoVersion`,
   * a missing entry file, or a manifest that stopped parsing. The plugin stays
   * listed so the user can see why it is not running.
   */
  unavailableReason: z.string().nullable(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

export const PluginRegistryFileSchema = z.object({
  name: PluginEntrySchema,
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
export type PluginRegistryFile = z.infer<typeof PluginRegistryFileSchema>;

export const PluginRegistryEntrySchema = z.object({
  manifest: PluginManifestSchema,
  // Capped as well as floored: the download budget bounds total bytes, not the
  // number of requests, so an entry declaring millions of tiny files would stay
  // inside it while the daemon walked the whole list.
  files: z.array(PluginRegistryFileSchema).min(1).max(64),
  /** Optional listing metadata the registry owns rather than the plugin. */
  publishedAt: z.string().optional(),
  installs: z.number().int().nonnegative().optional(),
});
export type PluginRegistryEntry = z.infer<typeof PluginRegistryEntrySchema>;

/**
 * What the registry sends. Parsed loosely on purpose: `version` is a number so
 * a version bump does not brick every shipped daemon, and entries stay
 * `unknown` so one malformed plugin does not take the registry offline. The
 * registry client validates each entry with `PluginRegistryEntrySchema` and
 * drops the ones that fail.
 */
export const PluginRegistryIndexEnvelopeSchema = z.object({
  version: z.number(),
  plugins: z.array(z.unknown()),
});
export type PluginRegistryIndexEnvelope = z.infer<typeof PluginRegistryIndexEnvelopeSchema>;

/** An index whose entries have already been validated one by one. */
export const PluginRegistryIndexSchema = z.object({
  version: z.number(),
  plugins: z.array(PluginRegistryEntrySchema),
});
export type PluginRegistryIndex = z.infer<typeof PluginRegistryIndexSchema>;

/** Persisted alongside the plugin directories at `$PASEO_HOME/plugins/installed.json`. */
export const PluginStateFileSchema = z.object({
  version: z.literal(1),
  plugins: z.array(
    z.object({
      id: PluginIdSchema,
      enabled: z.boolean(),
      installedAt: z.string(),
      source: PluginSourceSchema,
    }),
  ),
});
export type PluginStateFile = z.infer<typeof PluginStateFileSchema>;
