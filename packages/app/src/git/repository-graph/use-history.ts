import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { repositoryGraphQueryKey } from "@/git/query-keys";

const REPOSITORY_GRAPH_LIMIT = 200;

export function useRepositoryGraphHistory(input: {
  serverId: string;
  cwd: string;
  enabled: boolean;
}) {
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  // COMPAT(repositoryGraph): added in v0.2.5, remove after 2027-02-03.
  const supported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.repositoryGraph === true,
  );
  const enabled =
    input.enabled && supported && isConnected && Boolean(client) && Boolean(input.cwd);
  const query = useFetchQuery({
    queryKey: repositoryGraphQueryKey(input.serverId, input.cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return client.getRepositoryGraphHistory(input.cwd, REPOSITORY_GRAPH_LIMIT);
    },
    enabled,
    staleTimeMs: 30_000,
    dataShape: "list",
  });
  return { ...query, supported, isConnected };
}
