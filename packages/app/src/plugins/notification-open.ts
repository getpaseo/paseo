import type {
  PluginCommandCapabilities,
  PluginNotificationOpenContext,
  PluginNotificationOpenEvent,
} from "@getpaseo/plugin/client";
import type { NotificationOpenTarget } from "@/notification-open/model";
import { buildHostRootRoute, parseServerIdFromPathname } from "@/utils/host-routes";
import { createPluginCapabilities } from "./actions";
import { cloneAndFreeze } from "./freeze";
import type { PluginCatalogStatus } from "./registry";
import { buildPluginSurfaceRoute, parsePluginScreenParams } from "./routes";
import type { InstalledPlugin } from "./types";

export const PLUGIN_NOTIFICATION_CATALOG_TIMEOUT_MS = 8_000;

export type PluginNotificationTarget = Extract<NotificationOpenTarget, { kind: "plugin" }>;

export interface PluginNotificationOpenRegistry {
  getSnapshot(): readonly InstalledPlugin[];
  getCatalogStatus(serverId: string): PluginCatalogStatus;
  subscribe(listener: () => void): () => void;
}

export interface PluginNotificationOpenDependencies {
  registry: PluginNotificationOpenRegistry;
  timeoutMs?: number;
  createCapabilities?: (plugin: InstalledPlugin) => PluginCommandCapabilities;
  isHostRegistered?: (serverId: string) => boolean;
  focusHost?: (serverId: string) => void;
  openAgent: (input: { serverId: string; agentId: string }) => string | void;
  openWorkspace: (input: { serverId: string; workspaceId: string }) => string | void;
  openRoute: (route: string) => void;
  onError?: (error: unknown, context: { serverId: string; pluginId: string }) => void;
}

function findInstalledPlugin(
  registry: PluginNotificationOpenRegistry,
  serverId: string,
  pluginId: string,
): InstalledPlugin | null {
  return (
    registry
      .getSnapshot()
      .find((plugin) => plugin.serverId === serverId && plugin.id === pluginId) ?? null
  );
}

async function waitForPluginInstallation(
  registry: PluginNotificationOpenRegistry,
  serverId: string,
  pluginId: string,
  timeoutMs: number,
): Promise<InstalledPlugin | null> {
  const existing = findInstalledPlugin(registry, serverId, pluginId);
  if (existing) {
    return existing;
  }
  if (registry.getCatalogStatus(serverId) !== "loading" || timeoutMs <= 0) {
    return null;
  }

  let resolvePromise!: (plugin: InstalledPlugin | null) => void;
  const promise = new Promise<InstalledPlugin | null>((resolve) => {
    resolvePromise = resolve;
  });
  let settled = false;
  let unsubscribe = () => {};
  const finish = (plugin: InstalledPlugin | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    resolvePromise(plugin);
  };
  const check = () => {
    const found = findInstalledPlugin(registry, serverId, pluginId);
    if (found) {
      finish(found);
      return;
    }
    if (registry.getCatalogStatus(serverId) !== "loading") {
      finish(null);
    }
  };
  const timer = setTimeout(() => {
    finish(findInstalledPlugin(registry, serverId, pluginId));
  }, timeoutMs);
  unsubscribe = registry.subscribe(check);
  check();
  return promise;
}

function applyDeclarativeFallback(
  target: PluginNotificationTarget,
  deps: Pick<PluginNotificationOpenDependencies, "openAgent" | "openWorkspace" | "openRoute">,
): void {
  const open = target.open;
  if (open?.type === "agent") {
    deps.openAgent({ serverId: target.serverId, agentId: open.agentId });
    return;
  }
  if (open?.type === "workspace") {
    deps.openWorkspace({ serverId: target.serverId, workspaceId: open.workspaceId });
    return;
  }
  if (open?.type === "screen") {
    try {
      const params = parsePluginScreenParams(open.params);
      deps.openRoute(
        buildPluginSurfaceRoute(
          target.serverId,
          target.pluginId,
          { kind: "surface", id: open.screenId },
          params,
        ),
      );
      return;
    } catch {
      // Fall back to host root route if params are malformed.
    }
  }
  deps.openRoute(buildHostRootRoute(target.serverId));
}

export async function openPluginNotification(
  target: PluginNotificationTarget,
  deps: PluginNotificationOpenDependencies,
): Promise<void> {
  const registry = deps.registry;
  const timeoutMs = deps.timeoutMs ?? PLUGIN_NOTIFICATION_CATALOG_TIMEOUT_MS;
  const plugin = await waitForPluginInstallation(
    registry,
    target.serverId,
    target.pluginId,
    timeoutMs,
  );

  if (plugin && plugin.notificationOpenHandlers.length > 0) {
    const capabilities =
      deps.createCapabilities?.(plugin) ??
      createPluginCapabilities(plugin, {
        openSettings(pluginId, screenId) {
          deps.openRoute(
            `/settings/hosts/${encodeURIComponent(plugin.serverId)}/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(screenId)}`,
          );
        },
        openSurface(pluginId, surfaceId, params) {
          deps.openRoute(
            buildPluginSurfaceRoute(
              plugin.serverId,
              pluginId,
              { kind: "surface", id: surfaceId },
              params,
            ),
          );
        },
        openWorkspacePanel() {
          throw new Error("No active workspace");
        },
        openAgentPanel() {
          throw new Error("No active workspace");
        },
      });

    const focusRouteHost = (route: string | void, fallbackServerId: string) => {
      if (!deps.focusHost) return;
      const destinationServerId =
        (typeof route === "string" ? parseServerIdFromPathname(route) : null) ?? fallbackServerId;
      if (!deps.isHostRegistered || deps.isHostRegistered(destinationServerId)) {
        deps.focusHost(destinationServerId);
      }
    };

    const event: PluginNotificationOpenEvent = Object.freeze({
      type: "opened" as const,
      notificationId: target.notificationId,
      data: target.data ? cloneAndFreeze(target.data) : undefined,
    });

    const context: PluginNotificationOpenContext = {
      ...capabilities,
      event,
      navigation: {
        openAgent: ({ agentId, serverId: targetServerId, focusHost }) => {
          const resolvedServerId = targetServerId ?? target.serverId;
          const route = deps.openAgent({ serverId: resolvedServerId, agentId });
          if (focusHost) {
            focusRouteHost(route, resolvedServerId);
          }
        },
        openWorkspace: ({ workspaceId, serverId: targetServerId, focusHost }) => {
          const resolvedServerId = targetServerId ?? target.serverId;
          const route = deps.openWorkspace({ serverId: resolvedServerId, workspaceId });
          if (focusHost) {
            focusRouteHost(route, resolvedServerId);
          }
        },
      },
    };

    let anySucceeded = false;
    for (const handler of plugin.notificationOpenHandlers) {
      try {
        await handler(context);
        anySucceeded = true;
      } catch (error) {
        if (deps.onError) {
          deps.onError(error, { serverId: target.serverId, pluginId: target.pluginId });
        } else {
          console.warn(
            `[Plugins] onNotificationOpen handler failed for ${target.serverId}/${target.pluginId}`,
            error,
          );
        }
      }
    }
    if (anySucceeded) {
      return;
    }
  }

  applyDeclarativeFallback(target, deps);
}
