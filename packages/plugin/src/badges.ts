import { z } from "zod";

/**
 * A sidebar badge is a count the host polls for. `0` clears the badge, so a
 * plugin never has to distinguish "nothing to show" from "not loaded yet".
 */
export const PluginSidebarBadgeSchema = z.object({
  count: z.number().int().min(0),
});

export type PluginSidebarBadge = z.infer<typeof PluginSidebarBadgeSchema>;

export const PLUGIN_SIDEBAR_BADGE_DEFAULT_INTERVAL_MS = 60_000;
export const PLUGIN_SIDEBAR_BADGE_MIN_INTERVAL_MS = 15_000;

export function resolvePluginSidebarBadgeInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) {
    return PLUGIN_SIDEBAR_BADGE_DEFAULT_INTERVAL_MS;
  }
  return Math.max(PLUGIN_SIDEBAR_BADGE_MIN_INTERVAL_MS, Math.floor(intervalMs));
}
