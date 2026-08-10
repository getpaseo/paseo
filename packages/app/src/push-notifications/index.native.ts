import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { revokeSubscription, startSubscription } from "./internal/subscriptions";

export function startPushNotifications(input: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  return startSubscription(input);
}

export function revokePushNotifications(input: {
  client: DaemonClient | null;
  serverId: string;
}): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}
