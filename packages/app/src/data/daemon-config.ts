import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export interface DaemonConfigQueryData {
  config: MutableDaemonConfig;
  overrideControlledPaths: readonly string[];
}

export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}
