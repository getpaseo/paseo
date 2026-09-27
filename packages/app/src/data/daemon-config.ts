import type { QueryClient } from "@tanstack/react-query";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export interface DaemonConfigClient {
  getDaemonConfig(): Promise<{ config: MutableDaemonConfig }>;
  patchDaemonConfig(patch: MutableDaemonConfigPatch): Promise<{ config: MutableDaemonConfig }>;
}

export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}

export function daemonConfigQueryOptions(
  serverId: string | null,
  client: DaemonConfigClient | null,
  disconnectedMessage: string,
) {
  return {
    queryKey: daemonConfigQueryKey(serverId),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) throw new Error(disconnectedMessage);
      return (await client.getDaemonConfig()).config;
    },
  };
}

export async function patchDaemonConfig(input: {
  serverId: string | null;
  client: DaemonConfigClient | null;
  queryClient: QueryClient;
  patch: MutableDaemonConfigPatch;
}): Promise<MutableDaemonConfig | undefined> {
  if (!input.client) return undefined;
  const { config } = await input.client.patchDaemonConfig(input.patch);
  input.queryClient.setQueryData(daemonConfigQueryKey(input.serverId), config);
  return config;
}

export function daemonConfigLoadState(
  config: MutableDaemonConfig | null,
  isError: boolean,
): "ready" | "error" | "loading" {
  if (config) return "ready";
  return isError ? "error" : "loading";
}
