import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export async function registerUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
  vapidPublicKey: string;
}): Promise<void> {
  void params;
}

export function subscribeUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  void params;
  return () => {};
}
