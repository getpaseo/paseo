import type { DaemonClient } from "@server/client/daemon-client";

export function usePushTokenRegistration(_params: {
  client: DaemonClient;
  serverId: string;
}): void {}
