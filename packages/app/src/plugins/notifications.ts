import type { PluginNotificationSourceContribution } from "@getpaseo/plugin";
import { PluginNotificationSchema, type PluginNotification } from "@getpaseo/plugin";
import { readPluginNotificationSource } from "@getpaseo/plugin/host";
import { sendOsNotification } from "@/utils/os-notifications";
import type {
  PluginNotificationReceiptScope,
  PluginNotificationReceiptStore,
} from "./notification-receipts";

export interface PluginNotifierDeps {
  sendOsNotification: typeof sendOsNotification;
}

export interface PluginNotifier {
  notify(notification: PluginNotification): Promise<boolean>;
}

const defaultDeps: PluginNotifierDeps = { sendOsNotification };

export interface PluginNotifierSource {
  serverId: string;
  pluginId: string;
  /** Surface IDs the plugin registered, used to reject unroutable click targets. */
  surfaceIds: readonly string[];
}

export function createPluginNotifier(
  source: PluginNotifierSource,
  deps: PluginNotifierDeps = defaultDeps,
): PluginNotifier {
  return {
    async notify(notification: PluginNotification) {
      const parsed = PluginNotificationSchema.parse(notification);
      const surface = parsed.surface;
      if (surface && !source.surfaceIds.includes(surface)) {
        throw new Error(`Plugin surface is unavailable: ${surface}`);
      }
      return await deps.sendOsNotification({
        title: parsed.title,
        ...(parsed.body ? { body: parsed.body } : {}),
        data: {
          serverId: source.serverId,
          pluginId: source.pluginId,
          ...(surface ? { pluginSurfaceId: surface } : {}),
          ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
          ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
        },
      });
    },
  };
}

export async function pollPluginNotificationSource({
  source,
  scope,
  invoke,
  notifier,
  receipts,
  reportError,
}: {
  source: PluginNotificationSourceContribution;
  scope: PluginNotificationReceiptScope;
  invoke(method: string, input: unknown): Promise<unknown>;
  notifier: PluginNotifier;
  receipts: PluginNotificationReceiptStore;
  reportError(error: unknown): void;
}): Promise<{ claimed: number; delivered: number }> {
  const result = await readPluginNotificationSource(source, invoke);
  const claimedIds = new Set(
    await receipts.claim(
      scope,
      result.notifications.map((notification) => notification.id),
    ),
  );
  let delivered = 0;
  for (const notification of result.notifications) {
    if (!claimedIds.has(notification.id)) continue;
    try {
      if (await notifier.notify(notification)) delivered += 1;
    } catch (error) {
      reportError(error);
    }
  }
  return { claimed: claimedIds.size, delivered };
}
