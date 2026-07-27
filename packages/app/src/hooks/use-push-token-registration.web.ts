import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Web has no Expo push token pipeline — keep the import graph free of expo-notifications. */
export function usePushTokenRegistration(_params: {
  client: DaemonClient;
  serverId: string;
}): void {}
