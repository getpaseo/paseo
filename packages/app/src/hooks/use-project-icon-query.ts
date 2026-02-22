import { useQuery } from "@tanstack/react-query";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import type { ProjectIcon } from "@server/shared/messages";

export function projectIconQueryKey(serverId: string, cwd: string) {
  return ["projectIcon", serverId, cwd] as const;
}

interface UseProjectIconQueryOptions {
  serverId: string;
  cwd: string;
}

export function useProjectIconQuery({ serverId, cwd }: UseProjectIconQueryOptions) {
  const { client, isConnected } = useHostRuntimeSession(serverId);

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
