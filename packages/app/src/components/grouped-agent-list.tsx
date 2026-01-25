import {
  View,
  Text,
  Pressable,
  Modal,
  RefreshControl,
  SectionList,
  type ViewToken,
  type SectionListRenderItem,
} from "react-native";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { router, usePathname } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQueries, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { deriveBranchLabel, deriveProjectPath } from "@/utils/agent-display-info";
import {
  groupAgents,
  parseRepoShortNameFromRemoteUrl,
  type ProjectGroup,
  type DateGroup,
} from "@/utils/agent-grouping";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  CHECKOUT_STATUS_STALE_TIME,
  type CheckoutStatusPayload,
  checkoutStatusQueryKey,
  useCheckoutStatusCacheOnly,
} from "@/hooks/use-checkout-status-query";
import {
  buildAgentNavigationKey,
  startNavigationTiming,
} from "@/utils/navigation-timing";

type SectionType =
  | { type: "project"; data: ProjectGroup }
  | { type: "date"; data: DateGroup };

interface SectionData {
  key: string;
  title: string;
  type: "project" | "date";
  data: AggregatedAgent[];
  /** For project sections, the first agent's serverId (to lookup checkout status) */
  firstAgentServerId?: string;
  /** For project sections, the first agent's id (to lookup checkout status) */
  firstAgentId?: string;
}

interface GroupedAgentListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
}

interface SectionHeaderProps {
  section: SectionData;
  isCollapsed: boolean;
  agentCount: number;
  onToggle: () => void;
}

function SectionHeader({
  section,
  isCollapsed,
  agentCount,
  onToggle,
}: SectionHeaderProps) {
  const { theme } = useUnistyles();

  // For project sections, try to get repo name from checkout status
  const checkoutQuery = useCheckoutStatusCacheOnly({
    serverId: section.firstAgentServerId ?? "",
    agentId: section.firstAgentId ?? "",
  });
  const checkout = checkoutQuery.data ?? null;

  // Derive display title: prefer repo name from remote URL, fallback to path-based name
  let displayTitle = section.title;
  if (section.type === "project" && checkout?.isGit && checkout.remoteUrl) {
    const repoName = parseRepoShortNameFromRemoteUrl(checkout.remoteUrl);
    if (repoName) {
      displayTitle = repoName;
    }
  }

  return (
    <Pressable
      style={({ hovered }) => [
        styles.sectionHeader,
        hovered && styles.sectionHeaderHovered,
      ]}
      onPress={onToggle}
    >
      <View style={styles.sectionHeaderLeft}>
        {isCollapsed ? (
          <ChevronRight
            size={14}
            color={theme.colors.foregroundMuted}
            style={styles.chevron}
          />
        ) : (
          <ChevronDown
            size={14}
            color={theme.colors.foregroundMuted}
            style={styles.chevron}
          />
        )}
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {displayTitle}
        </Text>
      </View>
      <Text style={styles.sectionCount}>{agentCount}</Text>
    </Pressable>
  );
}

export function GroupedAgentList({
  agents,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
}: GroupedAgentListProps) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set()
  );

  // Get the methods for the specific server
  const methods = useSessionStore((state) =>
    actionAgent?.serverId
      ? state.sessions[actionAgent.serverId]?.methods
      : undefined
  );
  const deleteAgent = methods?.deleteAgent;

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !methods);

  const handleAgentPress = useCallback(
    (serverId: string, agentId: string) => {
      if (isActionSheetVisible) {
        return;
      }

      // Clear attention flag when opening agent
      const session = useSessionStore.getState().sessions[serverId];
      if (session?.client) {
        session.client.clearAgentAttention(agentId);
      }

      const navigationKey = buildAgentNavigationKey(serverId, agentId);
      startNavigationTiming(navigationKey, {
        from: "home",
        to: "agent",
        params: { serverId, agentId },
      });

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;

      onAgentSelect?.();

      navigate(`/agent/${serverId}/${agentId}` as any);
    },
    [isActionSheetVisible, pathname, onAgentSelect]
  );

  const handleAgentLongPress = useCallback((agent: AggregatedAgent) => {
    setActionAgent(agent);
  }, []);

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleDeleteAgent = useCallback(() => {
    if (!actionAgent || !deleteAgent) {
      return;
    }
    deleteAgent(actionAgent.id);
    setActionAgent(null);
  }, [actionAgent, deleteAgent]);

  const toggleSection = useCallback((sectionKey: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }, []);

  // Subscribe to checkout status cache entries so project grouping can react
  // to remote URL updates (e.g. git worktrees in different directories).
  const checkoutCacheQueries = useQueries({
    queries: agents.map(
      (agent): UseQueryOptions<CheckoutStatusPayload> => ({
      queryKey: checkoutStatusQueryKey(agent.serverId, agent.id),
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

  // Group agents
  const { activeGroups, inactiveGroups } = useMemo(
    () =>
      groupAgents(agents, {
        getRemoteUrl: (agent) =>
          remoteUrlByAgentKey.get(`${agent.serverId}:${agent.id}`) ?? null,
      }),
    [agents, remoteUrlByAgentKey]
  );

  // Build sections for SectionList
  const sections: SectionData[] = useMemo(() => {
    const result: SectionData[] = [];

    for (const group of activeGroups) {
      const sectionKey = `project:${group.projectKey}`;
      const isCollapsed = collapsedSections.has(sectionKey);
      const firstAgent = group.agents[0];
      result.push({
        key: sectionKey,
        title: group.projectName,
        type: "project",
        data: isCollapsed ? [] : group.agents,
        firstAgentServerId: firstAgent?.serverId,
        firstAgentId: firstAgent?.id,
      });
    }

    for (const group of inactiveGroups) {
      const sectionKey = `date:${group.label}`;
      const isCollapsed = collapsedSections.has(sectionKey);
      result.push({
        key: sectionKey,
        title: group.label,
        type: "date",
        data: isCollapsed ? [] : group.agents,
      });
    }

    return result;
  }, [activeGroups, inactiveGroups, collapsedSections]);

  const viewabilityConfig = useMemo(
    () => ({ itemVisiblePercentThreshold: 30 }),
    []
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<ViewToken> }) => {
      for (const token of viewableItems) {
        const agent = token.item as AggregatedAgent | undefined;
        if (!agent) {
          continue;
        }

        const session = useSessionStore.getState().sessions[agent.serverId];
        const client = session?.client ?? null;
        const isConnected = session?.connection.isConnected ?? false;
        if (!client || !isConnected) {
          continue;
        }

        const queryKey = checkoutStatusQueryKey(agent.serverId, agent.id);
        const queryState = queryClient.getQueryState(queryKey);
        const isFetching = queryState?.fetchStatus === "fetching";
        const isFresh =
          typeof queryState?.dataUpdatedAt === "number" &&
          Date.now() - queryState.dataUpdatedAt < CHECKOUT_STATUS_STALE_TIME;
        if (isFetching || isFresh) {
          continue;
        }

        void queryClient.prefetchQuery({
          queryKey,
          queryFn: async () => await client.getCheckoutStatus(agent.id),
          staleTime: CHECKOUT_STATUS_STALE_TIME,
        });
      }
    }
  );

  const AgentListRow = useCallback(
    ({ agent }: { agent: AggregatedAgent }) => {
      const timeAgo = formatTimeAgo(agent.lastActivityAt);
      const agentKey = `${agent.serverId}:${agent.id}`;
      const isSelected = selectedAgentId === agentKey;
      const isRunning = agent.status === "running";
      const statusColor = isRunning
        ? theme.colors.palette.blue[500]
        : agent.requiresAttention
          ? theme.colors.success
          : null;

      const checkoutQuery = useCheckoutStatusCacheOnly({
        serverId: agent.serverId,
        agentId: agent.id,
      });
      const checkout = checkoutQuery.data ?? null;
      const projectPath = deriveProjectPath(agent.cwd, checkout);
      const branchLabel = deriveBranchLabel(checkout);

      return (
        <Pressable
          style={({ pressed, hovered }) => [
            styles.agentItem,
            isSelected && styles.agentItemSelected,
            hovered && styles.agentItemHovered,
            pressed && styles.agentItemPressed,
          ]}
          onPress={() => handleAgentPress(agent.serverId, agent.id)}
          onLongPress={() => handleAgentLongPress(agent)}
          testID={`agent-row-${agent.serverId}-${agent.id}`}
        >
          {({ hovered }) => (
            <View style={styles.agentContent}>
              <View style={styles.row}>
                {statusColor && (
                  <View
                    style={[styles.statusDot, { backgroundColor: statusColor }]}
                  />
                )}
                <Text
                  style={[
                    styles.agentTitle,
                    (isSelected || hovered) && styles.agentTitleHighlighted,
                  ]}
                  numberOfLines={1}
                >
                  {agent.title || "New Agent"}
                </Text>
              </View>

              <Text style={styles.secondaryRow} numberOfLines={1}>
                {shortenPath(projectPath)}
                {branchLabel ? ` · ${branchLabel}` : ""} · {timeAgo}
              </Text>
            </View>
          )}
        </Pressable>
      );
    },
    [
      handleAgentLongPress,
      handleAgentPress,
      selectedAgentId,
      theme.colors.palette.blue,
      theme.colors.success,
    ]
  );

  const renderItem: SectionListRenderItem<AggregatedAgent, SectionData> =
    useCallback(
      ({ item: agent }) => <AgentListRow agent={agent} />,
      [AgentListRow]
    );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionData }) => {
      const isCollapsed = collapsedSections.has(section.key);
      const agentCount =
        section.type === "project"
          ? activeGroups.find((g) => `project:${g.projectKey}` === section.key)
              ?.agents.length ?? 0
          : inactiveGroups.find((g) => `date:${g.label}` === section.key)
              ?.agents.length ?? 0;

      return (
        <SectionHeader
          section={section}
          isCollapsed={isCollapsed}
          agentCount={agentCount}
          onToggle={() => toggleSection(section.key)}
        />
      );
    },
    [collapsedSections, activeGroups, inactiveGroups, toggleSection]
  );

  const keyExtractor = useCallback(
    (agent: AggregatedAgent) => `${agent.serverId}:${agent.id}`,
    []
  );

  return (
    <>
      <SectionList
        sections={sections}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={false}
        extraData={selectedAgentId}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={16}
        ListFooterComponent={listFooterComponent}
        onViewableItemsChanged={onViewableItemsChanged.current}
        viewabilityConfig={viewabilityConfig}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.foregroundMuted}
              colors={[theme.colors.foregroundMuted]}
            />
          ) : undefined
        }
      />

      <Modal
        visible={isActionSheetVisible}
        animationType="fade"
        transparent
        onRequestClose={handleCloseActionSheet}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={handleCloseActionSheet}
          />
          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {actionAgent?.title || "Delete agent"}
            </Text>
            <Text style={styles.sheetSubtitle}>
              {isActionDaemonUnavailable
                ? "This host is offline—actions will be available once it reconnects automatically."
                : "Removing this agent only deletes it from Paseo. Claude/Codex keeps the original project."}
            </Text>
            <Pressable
              disabled={!deleteAgent || isActionDaemonUnavailable}
              style={[styles.sheetButton, styles.sheetDeleteButton]}
              onPress={handleDeleteAgent}
              testID="agent-action-delete"
            >
              <Text
                style={[
                  styles.sheetDeleteText,
                  (!deleteAgent || isActionDaemonUnavailable) &&
                    styles.sheetDeleteTextDisabled,
                ]}
              >
                {isActionDaemonUnavailable ? "Host offline" : "Delete agent"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.sheetButton, styles.sheetCancelButton]}
              onPress={handleCloseActionSheet}
              testID="agent-action-cancel"
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  sectionHeaderHovered: {
    backgroundColor: theme.colors.surface1,
  },
  sectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },
  chevron: {
    marginRight: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  sectionCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginLeft: theme.spacing[2],
  },
  agentItem: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
  },
  agentItemSelected: {
    backgroundColor: theme.colors.surface2,
  },
  agentItemHovered: {
    backgroundColor: theme.colors.surface1,
  },
  agentItemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  agentContent: {
    flex: 1,
    gap: theme.spacing[0],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    opacity: 0.8,
  },
  agentTitleHighlighted: {
    color: theme.colors.foreground,
    opacity: 1,
  },
  secondaryRow: {
    fontSize: theme.fontSize.sm,
    fontWeight: "300",
    color: theme.colors.foregroundMuted,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheetContainer: {
    backgroundColor: theme.colors.surface2,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[4],
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sheetSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sheetButton: {
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  sheetDeleteButton: {
    backgroundColor: theme.colors.destructive,
  },
  sheetDeleteText: {
    color: theme.colors.destructiveForeground,
    fontWeight: theme.fontWeight.semibold,
  },
  sheetDeleteTextDisabled: {
    opacity: 0.5,
  },
  sheetCancelButton: {
    backgroundColor: theme.colors.surface2,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
}));
