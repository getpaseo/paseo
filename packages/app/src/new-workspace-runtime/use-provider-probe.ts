import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";

import type { WorkspaceProviderProbeState } from "./model";

export function useWorkspaceProviderProbe(input: {
  serverId: string;
  projectId: string | null;
  runtimeId: string;
  supportsWorkspaceRuntimes: boolean;
  isConnected: boolean;
  client: DaemonClient | null;
}): WorkspaceProviderProbeState & { retry(): void } {
  const query = useFetchQuery({
    queryKey: ["workspace-provider-probe", input.serverId, input.projectId, input.runtimeId],
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
    queryFn: async () => {
      if (!input.client || !input.projectId) throw new Error("Choose a connected project");
      const result = await input.client.ensureWorkspaceRuntimeProbe({
        projectId: input.projectId,
        runtimeId: input.runtimeId,
      });
      if (result.status === "error" || !result.workspaceId) {
        throw new Error(result.error ?? "Failed to prepare the runtime environment");
      }
      return result.workspaceId;
    },
    enabled:
      input.supportsWorkspaceRuntimes &&
      input.isConnected &&
      Boolean(input.client && input.projectId),
    retry: false,
  });
  const retry = () => void query.refetch();
  if (!input.supportsWorkspaceRuntimes) return { status: "legacy", retry };
  if (query.isError) {
    return {
      status: "error",
      error: query.error instanceof Error ? query.error.message : String(query.error),
      retry,
    };
  }
  if (query.data) return { status: "ready", workspaceId: query.data, retry };
  return { status: "loading", retry };
}
