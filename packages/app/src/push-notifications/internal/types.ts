import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";
import type { SettingsDeps } from "@/hooks/use-settings/storage";

export type PushNotificationClient = Pick<
  DaemonClient,
  | "isConnected"
  | "registerPushToken"
  | "unregisterPushToken"
  | "subscribeConnectionStatus"
  | "getLastServerInfoMessage"
> & {
  on?: (type: "status", handler: (message: SessionOutboundMessage) => void) => () => void;
};

export interface StartPushNotificationsInput {
  client: PushNotificationClient;
  serverId: string;
  queryClient?: QueryClient;
  settingsDeps?: SettingsDeps;
  resolveToken?: (serverId: string) => Promise<string | null>;
}

export interface RevokePushNotificationsInput {
  client: Pick<
    DaemonClient,
    "isConnected" | "unregisterPushToken" | "getLastServerInfoMessage"
  > | null;
  serverId: string;
}
