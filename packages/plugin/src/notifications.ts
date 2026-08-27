import { z } from "zod";
import type { PluginNotificationSourceContribution } from "./contracts.js";
import { callPluginRpc } from "./rpc.js";

export const DEFAULT_PLUGIN_NOTIFICATION_INTERVAL_MS = 60_000;
export const MIN_PLUGIN_NOTIFICATION_INTERVAL_MS = 15_000;

const PluginNotificationTargetIdSchema = z.string().trim().min(1).max(200);

export const PluginNotificationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(1_000).optional(),
    workspaceId: PluginNotificationTargetIdSchema.optional(),
    agentId: PluginNotificationTargetIdSchema.optional(),
    surface: PluginNotificationTargetIdSchema.optional(),
  })
  .strict();

export const PluginNotificationEventSchema = PluginNotificationSchema.extend({
  /** Stable identity for this event. Reusing it prevents repeat notifications. */
  id: z.string().trim().min(1).max(200),
});

export const PluginNotificationPollResultSchema = z
  .object({
    notifications: z.array(PluginNotificationEventSchema).max(20),
  })
  .strict()
  .superRefine(({ notifications }, context) => {
    const ids = new Set<string>();
    for (const [index, notification] of notifications.entries()) {
      if (ids.has(notification.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate notification id: ${notification.id}`,
          path: ["notifications", index, "id"],
        });
      }
      ids.add(notification.id);
    }
  });

export type PluginNotification = z.infer<typeof PluginNotificationSchema>;
export type PluginNotificationEvent = z.infer<typeof PluginNotificationEventSchema>;
export type PluginNotificationPollResult = z.infer<typeof PluginNotificationPollResultSchema>;

export function resolvePluginNotificationInterval(intervalMs?: number): number {
  if (intervalMs === undefined) return DEFAULT_PLUGIN_NOTIFICATION_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Plugin notification interval must be a positive finite number");
  }
  return Math.max(MIN_PLUGIN_NOTIFICATION_INTERVAL_MS, Math.round(intervalMs));
}

export async function readPluginNotificationSource(
  source: PluginNotificationSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
): Promise<PluginNotificationPollResult> {
  const output = await callPluginRpc(source.rpc, invoke, {});
  return PluginNotificationPollResultSchema.parseAsync(output);
}
