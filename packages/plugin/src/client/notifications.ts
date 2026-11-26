import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginCommandCapabilities, PluginHostNavigationActions } from "./contracts.js";

export interface PluginNotificationOpenEvent {
  readonly type: "opened";
  readonly notificationId: string;
  readonly data: Readonly<Record<string, JsonValue>> | undefined;
}

export interface PluginNotificationOpenContext extends PluginCommandCapabilities {
  readonly event: PluginNotificationOpenEvent;
  readonly navigation: PluginHostNavigationActions;
}

export type PluginNotificationOpenHandler = (
  context: PluginNotificationOpenContext,
) => void | Promise<void>;
