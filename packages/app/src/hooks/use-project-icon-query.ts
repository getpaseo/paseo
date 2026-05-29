import { useQuery } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ProjectIcon } from "@getpaseo/protocol/messages";

export function projectIconQueryKey(serverId: string, cwd: string) {
  return ["projectIcon", serverId, cwd] as const;
}

export function projectIconToDataUri(icon: ProjectIcon | null): string | null {
  if (!icon) {
    return null;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

interface UseProjectIconQueryOptions {
  serverId: string;
  cwd: string;
}

export function useProjectIconQuery({ serverId, cwd }: UseProjectIconQueryOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: projectIconQueryKey(serverId, cwd),
    queryFn: async (): Promise<ProjectIcon | null> => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const result = await client.requestProjectIcon(cwd);
      return result.icon;
    },
    enabled: !!client && isConnected && !!cwd,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    icon: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
