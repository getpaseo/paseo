import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
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
  const queryClient = useQueryClient();
  const [checkoutCacheBump, setCheckoutCacheBump] = useState(0);

  // Re-render when checkout status cache updates so grouping can switch from cwd→remote.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const queryKey = event?.query?.queryKey;
      if (!Array.isArray(queryKey) || queryKey[0] !== "checkoutStatus") {
        return;
      }
      setCheckoutCacheBump((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  const remoteUrlByAgentKey = useMemo(() => {
    const result = new Map<string, string | null>();
    for (const agent of agents) {
      const checkout =
        queryClient.getQueryData<CheckoutStatusPayload>(
          checkoutStatusQueryKey(agent.serverId, agent.cwd)
        ) ?? null;
      result.set(`${agent.serverId}:${agent.id}`, checkout?.remoteUrl ?? null);
    }
    return result;
  }, [agents, checkoutCacheBump, queryClient]);

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
