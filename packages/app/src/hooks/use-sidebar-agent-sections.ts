import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
  CHECKOUT_STATUS_STALE_TIME,
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
  // Subscribe to checkout status cache entries for each visible agent so that grouping
  // can switch from cwd→remote as soon as checkout status is prefetched.
  //
  // This avoids a brief UI state where two separate sections can render with the
  // same icon/title while grouping is still keyed by cwd.
  const checkoutStatusQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: checkoutStatusQueryKey(agent.serverId, agent.cwd),
      queryFn: async (): Promise<CheckoutStatusPayload> => {
        throw new Error("Checkout status query is disabled in sidebar grouping");
      },
      enabled: false,
      staleTime: CHECKOUT_STATUS_STALE_TIME,
    })),
  });

  const remoteUrlByAgentKey = useMemo(() => {
    const result = new Map<string, string | null>();
    for (let idx = 0; idx < agents.length; idx++) {
      const agent = agents[idx];
      const checkout = checkoutStatusQueries[idx]?.data ?? null;
      result.set(`${agent.serverId}:${agent.id}`, checkout?.remoteUrl ?? null);
    }
    return result;
  }, [agents, checkoutStatusQueries]);

  const projectOrder = useSectionOrderStore((state) => state.projectOrder);
  const setProjectOrder = useSectionOrderStore((state) => state.setProjectOrder);

  const { activeGroups } = useMemo(
    () =>
      groupAgents(agents, {
        getRemoteUrl: (agent) => remoteUrlByAgentKey.get(`${agent.serverId}:${agent.id}`) ?? null,
      }),
    [agents, remoteUrlByAgentKey],
  );

  const sortedGroups = useMemo(
    () => sortProjectsByStoredOrder(activeGroups, projectOrder),
    [activeGroups, projectOrder],
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
