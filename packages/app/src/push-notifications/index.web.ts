import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function startPushNotifications(_input: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: {
  client: DaemonClient | null;
  serverId: string;
}): Promise<void> {
  // Push notifications are native-only.
}
