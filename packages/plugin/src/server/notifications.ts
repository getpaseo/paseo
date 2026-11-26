import type { JsonValue } from "@getpaseo/protocol/agent-types";

export type PluginNotificationOpenTarget =
  | { type: "agent"; agentId: string }
  | { type: "workspace"; workspaceId: string }
  | { type: "screen"; screenId: string; params?: Record<string, string> };

export interface PluginNotificationSendInput {
  title: string;
  body: string;
  /** Identical keys from the same plugin within 60 s are dropped as deduplicated. */
  key?: string;
  /** Declarative navigation on tap when no client `onNotificationOpen` handler handles it. */
  open?: PluginNotificationOpenTarget;
  /** JSON payload delivered to `client.onNotificationOpen` on tap (<= 1024 UTF-8 bytes). */
  data?: Record<string, JsonValue>;
}

export type PluginNotificationSendResult =
  | { status: "sent"; notificationId: string }
  | { status: "deduplicated" }
  | { status: "rate_limited" };

export interface PluginNotifications {
  send(input: PluginNotificationSendInput): Promise<PluginNotificationSendResult>;
}
