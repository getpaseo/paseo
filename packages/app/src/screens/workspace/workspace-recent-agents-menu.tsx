import { useCallback, useMemo, type ReactNode } from "react";
import { router, type Href } from "expo-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "@/hooks/agent-history-query-key";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { buildSessionsRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import {
  RECENTLY_CLOSED_AGENT_LIMIT,
  selectRecentlyClosedAgents,
} from "@/workspace-tabs/recently-closed";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function reopenRecentlyClosedAgent(input: {
  serverId: string;
  agentId: string;
  workspaceId: string | null | undefined;
  queryClient: QueryClient;
}): void {
  navigateToAgent({
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    pin: true,
  });
  const refresh = getHostRuntimeStore().getClient(input.serverId)?.refreshAgent(input.agentId);
  if (!refresh) {
    return;
  }
  void refresh
    .then(() => {
      void input.queryClient.invalidateQueries({
        queryKey: agentHistoryQueryKey(input.serverId),
      });
      void input.queryClient.invalidateQueries({
        queryKey: allAgentHistoryQueryRootKey(),
      });
      return undefined;
    })
    .catch(() => undefined);
}

function RecentlyClosedAgentIconGlyph({
  Icon,
  color = "",
}: {
  Icon: ProviderIconComponent;
  color?: string;
}) {
  return <Icon size={14} color={color} />;
}

const ThemedRecentlyClosedAgentIconGlyph = withUnistyles(RecentlyClosedAgentIconGlyph);

function RecentlyClosedAgentItem({
  agent,
  onSelect,
}: {
  agent: AggregatedAgent;
  onSelect: (agent: AggregatedAgent) => void;
}) {
  const { t } = useTranslation();
  const leading = useMemo(() => {
    const Icon = getProviderIcon(agent.provider, agent.serverId);
    return <ThemedRecentlyClosedAgentIconGlyph Icon={Icon} uniProps={mutedColorMapping} />;
  }, [agent.provider, agent.serverId]);
  const handleSelect = useCallback(() => onSelect(agent), [agent, onSelect]);
  const archivedAt = agent.archivedAt;

  return (
    <DropdownMenuItem
      testID={`workspace-recent-agents-item-${agent.id}`}
      leading={leading}
      description={archivedAt ? formatTimeAgo(archivedAt) : undefined}
      onSelect={handleSelect}
    >
      {agent.title || t("agentList.fallbackTitle")}
    </DropdownMenuItem>
  );
}

function recentAgentsRows(input: {
  isInitialLoad: boolean;
  recentlyClosed: readonly AggregatedAgent[];
  loadingLabel: string;
  emptyLabel: string;
  onSelect: (agent: AggregatedAgent) => void;
}): ReactNode {
  if (input.isInitialLoad) {
    return (
      <DropdownMenuItem disabled muted testID="workspace-recent-agents-loading">
        {input.loadingLabel}
      </DropdownMenuItem>
    );
  }
  if (input.recentlyClosed.length === 0) {
    return (
      <DropdownMenuItem disabled muted testID="workspace-recent-agents-empty">
        {input.emptyLabel}
      </DropdownMenuItem>
    );
  }
  return input.recentlyClosed.map((agent) => (
    <RecentlyClosedAgentItem key={agent.id} agent={agent} onSelect={input.onSelect} />
  ));
}

export function WorkspaceRecentAgentsMenuContent({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { agents, isInitialLoad, hostErrors } = useAgentHistory({ serverId });
  const recentlyClosed = useMemo(
    () =>
      selectRecentlyClosedAgents(agents, {
        workspaceId,
        limit: RECENTLY_CLOSED_AGENT_LIMIT,
      }),
    [agents, workspaceId],
  );

  const handleSelectAgent = useCallback(
    (agent: AggregatedAgent) => {
      reopenRecentlyClosedAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        queryClient,
      });
    },
    [queryClient],
  );

  const handleShowAll = useCallback(() => {
    router.push(buildSessionsRoute() as Href);
  }, []);

  return (
    <DropdownMenuContent
      side="bottom"
      align="start"
      offset={4}
      minWidth={260}
      maxWidth={360}
      maxHeight={420}
      scrollable
      testID="workspace-recent-agents-menu"
    >
      <DropdownMenuLabel>{t("workspace.tabs.recentAgents.title")}</DropdownMenuLabel>
      {hostErrors.map((error) => (
        <DropdownMenuItem key={error.serverId} disabled muted>
          {t("sessions.hostLoadFailed", { host: error.serverName })}
        </DropdownMenuItem>
      ))}
      {recentAgentsRows({
        isInitialLoad,
        recentlyClosed,
        loadingLabel: t("workspace.tabs.recentAgents.loading"),
        emptyLabel: t("workspace.tabs.recentAgents.empty"),
        onSelect: handleSelectAgent,
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem testID="workspace-recent-agents-show-all" onSelect={handleShowAll}>
        {t("workspace.tabs.recentAgents.showAll")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
