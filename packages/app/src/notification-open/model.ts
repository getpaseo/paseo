import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginNotificationOpenTarget } from "@getpaseo/protocol/messages";
import { buildHostRootRoute } from "@/utils/host-routes";
import type { NotificationOpenSource, NotificationTap } from "./source";

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

export type NotificationOpenTarget =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "terminal"; serverId: string; workspaceId: string; terminalId: string }
  | {
      kind: "plugin";
      serverId: string;
      pluginId: string;
      notificationId: string;
      open?: PluginNotificationOpenTarget;
      data?: Record<string, JsonValue>;
    }
  | { kind: "host"; serverId: string };

function readId(data: object, key: string): string {
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePluginOpenTarget(raw: unknown): PluginNotificationOpenTarget | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const type = readId(raw, "type");
  if (type === "agent") {
    const agentId = readId(raw, "agentId");
    return agentId ? { type: "agent", agentId } : undefined;
  }
  if (type === "workspace") {
    const workspaceId = readId(raw, "workspaceId");
    return workspaceId ? { type: "workspace", workspaceId } : undefined;
  }
  if (type === "screen") {
    const screenId = readId(raw, "screenId");
    if (!screenId) return undefined;
    const rawParams = Reflect.get(raw, "params");
    if (rawParams === undefined) {
      return { type: "screen", screenId };
    }
    if (!isPlainRecord(rawParams)) return undefined;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawParams)) {
      if (!key.trim() || typeof value !== "string") return undefined;
      params[key] = value;
    }
    return { type: "screen", screenId, params };
  }
  return undefined;
}

export function parseNotificationOpenTarget(data: unknown): NotificationOpenTarget | null {
  if (!isPlainRecord(data)) return null;
  const serverId = readId(data, "serverId");
  if (!serverId) return null;
  if (readId(data, "kind") === "plugin") {
    const pluginId = readId(data, "pluginId");
    const notificationId = readId(data, "notificationId");
    if (!pluginId || !notificationId) return null;
    const open = parsePluginOpenTarget(Reflect.get(data, "open"));
    const rawData = Reflect.get(data, "data");
    const payloadData = isPlainRecord(rawData) ? (rawData as Record<string, JsonValue>) : undefined;
    return {
      kind: "plugin",
      serverId,
      pluginId,
      notificationId,
      ...(open ? { open } : {}),
      ...(payloadData ? { data: payloadData } : {}),
    };
  }
  const workspaceId = readId(data, "workspaceId");
  const terminalId = readId(data, "terminalId");
  if (workspaceId && terminalId) return { kind: "terminal", serverId, workspaceId, terminalId };
  const agentId = readId(data, "agentId");
  if (agentId) return { kind: "agent", serverId, agentId };
  return { kind: "host", serverId };
}

interface NotificationOpenRouterDeps {
  source: NotificationOpenSource;
  openAgent: (target: { serverId: string; agentId: string }) => void;
  openRoute: (route: string) => void;
  openTerminal: (target: Extract<NotificationOpenTarget, { kind: "terminal" }>) => void;
  openPlugin?: (
    target: Extract<NotificationOpenTarget, { kind: "plugin" }>,
  ) => void | Promise<void>;
  whenReadyToNavigate: () => Promise<void>;
}

export function createNotificationOpenRouter(deps: NotificationOpenRouterDeps) {
  const handledIds = new Set<string>();
  let launchTaken = false;
  async function receive(tap: NotificationTap) {
    if (handledIds.has(tap.id)) return;
    handledIds.add(tap.id);
    await deps.whenReadyToNavigate();
    const target = parseNotificationOpenTarget(tap.data);
    if (target?.kind === "agent") {
      deps.openAgent({ serverId: target.serverId, agentId: target.agentId });
    } else if (target?.kind === "terminal") {
      deps.openTerminal(target);
    } else if (target?.kind === "plugin") {
      if (deps.openPlugin) {
        await deps.openPlugin(target);
      } else {
        deps.openRoute(buildHostRootRoute(target.serverId));
      }
    } else if (target?.kind === "host") {
      deps.openRoute(buildHostRootRoute(target.serverId));
    }
    deps.source.acknowledge(tap);
  }
  return {
    start() {
      const unsubscribe = deps.source.subscribe((tap) => {
        void receive(tap);
      });
      if (!launchTaken) {
        launchTaken = true;
        void deps.source.takeLaunchTap().then((tap) => {
          return tap ? receive(tap) : undefined;
        });
      }
      return unsubscribe;
    },
  };
}
