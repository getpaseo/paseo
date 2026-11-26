import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginCommandCapabilities } from "./contracts.js";

export interface PluginNotificationOpenEvent {
  readonly type: "opened";
  readonly notificationId: string;
  readonly data: Readonly<Record<string, JsonValue>> | undefined;
}

export interface PluginNotificationOpenContext extends PluginCommandCapabilities {
  readonly event: PluginNotificationOpenEvent;
  readonly navigation: {
    readonly openAgent: (input: {
      readonly agentId: string;
      readonly serverId?: string;
      /** Select only the destination host in the sidebar and clear project/label filters. */
      readonly focusHost?: boolean;
    }) => void;
    readonly openWorkspace: (input: {
      readonly workspaceId: string;
      readonly serverId?: string;
      /** Select only the destination host in the sidebar and clear project/label filters. */
      readonly focusHost?: boolean;
    }) => void;
  };
}

export type PluginNotificationOpenHandler = (
  context: PluginNotificationOpenContext,
) => void | Promise<void>;
