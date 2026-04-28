import { useQuery } from "@tanstack/react-query";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";

export interface AgentMeta {
  id: string;
  label: string;
  bin: string;
  installHint?: string;
  supportsMcp: boolean;
  supportsSkills: boolean;
}

export interface InstalledAgentsResult {
  agents: AgentMeta[];
  installedIds: Set<string>;
}

/**
 * Ask the connected daemon which agents it knows about + which are on PATH.
 * Used by the Add modals to render only tools the user actually has.
 */
export function useInstalledAgents() {
  const hosts = useHosts();
  const primaryServerId = hosts[0]?.serverId ?? null;
  const client = useHostRuntimeClient(primaryServerId ?? "");

  return useQuery<InstalledAgentsResult>({
    queryKey: ["library", "installed-agents", primaryServerId],
    enabled: !!client,
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) throw new Error("no daemon");
      const res = await client.listLibraryAgents();
      return {
        agents: res.agents as AgentMeta[],
        installedIds: new Set(res.installedIds),
      };
    },
  });
}
