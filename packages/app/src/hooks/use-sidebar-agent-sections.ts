import { useEffect, useMemo } from "react";
import { useQueries, type UseQueryOptions } from "@tanstack/react-query";
import {
  CHECKOUT_STATUS_STALE_TIME,
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { groupAgents } from "@/utils/agent-grouping";
import { useSectionOrderStore, sortProjectsByStoredOrder } from "@/stores/section-order-store";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export interface SidebarSectionData {
  key: string;
  projectKey: string;
  title: string;
  agents: AggregatedAgent[];
  /** For project sections, the first agent's serverId (to lookup checkout status) */
  firstAgentServerId?: string;
  /** For project sections, the first agent's id (to lookup checkout status) */
  firstAgentId?: string;
  /** Working directory for the project (from first agent) */
  workingDir?: string;
}

export function useSidebarAgentSections(agents: AggregatedAgent[]): SidebarSectionData[] {
  const checkoutCacheQueries = useQueries({
    queries: agents.map(
      (agent): UseQueryOptions<CheckoutStatusPayload> => ({
        queryKey: checkoutStatusQueryKey(agent.serverId, agent.cwd),
        enabled: false,
        staleTime: CHECKOUT_STATUS_STALE_TIME,
        queryFn: async (): Promise<CheckoutStatusPayload> => {
          throw new Error("checkout status cache-only query should not run");
        },
      })
    ),
  });

  const remoteUrlByAgentKey = useMemo(() => {
    const result = new Map<string, string | null>();
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      if (!agent) {
        continue;
      }
      const checkout = checkoutCacheQueries[i]?.data ?? null;
      const remoteUrl = checkout?.remoteUrl ?? null;
      result.set(`${agent.serverId}:${agent.id}`, remoteUrl);
    }
    return result;
  }, [agents, checkoutCacheQueries]);

  const projectOrder = useSectionOrderStore((state) => state.projectOrder);
  const setProjectOrder = useSectionOrderStore((state) => state.setProjectOrder);

  const { activeGroups } = useMemo(
    () =>
      groupAgents(agents, {
        getRemoteUrl: (agent) =>
          remoteUrlByAgentKey.get(`${agent.serverId}:${agent.id}`) ?? null,
      }),
    [agents, remoteUrlByAgentKey]
  );

  const sortedGroups = useMemo(
    () => sortProjectsByStoredOrder(activeGroups, projectOrder),
    [activeGroups, projectOrder]
  );

  const sections: SidebarSectionData[] = useMemo(() => {
    const result: SidebarSectionData[] = [];

    for (const group of sortedGroups) {
      const sectionKey = `project:${group.projectKey}`;
      const firstAgent = group.agents[0];
      result.push({
        key: sectionKey,
        projectKey: group.projectKey,
        title: group.projectName,
        agents: group.agents,
        firstAgentServerId: firstAgent?.serverId,
        firstAgentId: firstAgent?.id,
        workingDir: firstAgent?.cwd,
      });
    }

    return result;
  }, [sortedGroups]);

  // Sync section order when new projects appear.
  useEffect(() => {
    const currentKeys = sections.map((s) => s.projectKey);
    const storedKeys = new Set(projectOrder);
    const newKeys = currentKeys.filter((key) => !storedKeys.has(key));

    if (newKeys.length > 0) {
      setProjectOrder([...projectOrder, ...newKeys]);
    }
  }, [projectOrder, sections, setProjectOrder]);

  return sections;
}

