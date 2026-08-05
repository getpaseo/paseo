import { z } from "zod";
import {
  InstalledPluginSchema,
  PluginEntrySchema,
  PluginIdSchema,
  PluginRegistryEntrySchema,
} from "./types.js";

export const PluginsListRequestSchema = z.object({
  type: z.literal("plugins.list.request"),
  requestId: z.string(),
});

export const PluginsGetEntryRequestSchema = z.object({
  type: z.literal("plugins.get_entry.request"),
  requestId: z.string(),
  pluginId: PluginIdSchema,
  entry: PluginEntrySchema,
});

export const PluginsBrowseRequestSchema = z.object({
  type: z.literal("plugins.browse.request"),
  requestId: z.string(),
  /** Bypass the daemon's cached copy of the registry index. */
  refresh: z.boolean().optional(),
});

export const PluginsInstallRequestSchema = z.object({
  type: z.literal("plugins.install.request"),
  requestId: z.string(),
  pluginId: PluginIdSchema,
});

export const PluginsUninstallRequestSchema = z.object({
  type: z.literal("plugins.uninstall.request"),
  requestId: z.string(),
  pluginId: PluginIdSchema,
});

export const PluginsSetEnabledRequestSchema = z.object({
  type: z.literal("plugins.set_enabled.request"),
  requestId: z.string(),
  pluginId: PluginIdSchema,
  enabled: z.boolean(),
});

export const PluginsListResponseSchema = z.object({
  type: z.literal("plugins.list.response"),
  payload: z.object({
    requestId: z.string(),
    plugins: z.array(InstalledPluginSchema),
    error: z.string().nullable(),
  }),
});

export const PluginsGetEntryResponseSchema = z.object({
  type: z.literal("plugins.get_entry.response"),
  payload: z.object({
    requestId: z.string(),
    pluginId: PluginIdSchema,
    entry: PluginEntrySchema,
    html: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const PluginsBrowseResponseSchema = z.object({
  type: z.literal("plugins.browse.response"),
  payload: z.object({
    requestId: z.string(),
    registryUrl: z.string(),
    plugins: z.array(PluginRegistryEntrySchema),
    error: z.string().nullable(),
  }),
});

export const PluginsInstallResponseSchema = z.object({
  type: z.literal("plugins.install.response"),
  payload: z.object({
    requestId: z.string(),
    plugin: InstalledPluginSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const PluginsUninstallResponseSchema = z.object({
  type: z.literal("plugins.uninstall.response"),
  payload: z.object({
    requestId: z.string(),
    pluginId: PluginIdSchema,
    error: z.string().nullable(),
  }),
});

export const PluginsSetEnabledResponseSchema = z.object({
  type: z.literal("plugins.set_enabled.response"),
  payload: z.object({
    requestId: z.string(),
    plugin: InstalledPluginSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * Broadcast, not a correlated response: the daemon pushes the full installed
 * set to every session whenever it changes, so a second client does not sit on
 * a stale plugin list after an install elsewhere.
 */
export const PluginsChangedMessageSchema = z.object({
  type: z.literal("plugins.changed"),
  payload: z.object({
    plugins: z.array(InstalledPluginSchema),
  }),
});
