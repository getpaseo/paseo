import {
  View,
  Text,
  Pressable,
  Modal,
  Image,
} from "react-native";
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  type ReactElement,
  type MutableRefObject,
} from "react";
import { router, usePathname } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { type GestureType } from "react-native-gesture-handler";
import { useQueries, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import {
  DraggableList,
  type DraggableRenderItemInfo,
} from "./draggable-list";
import { formatTimeAgo } from "@/utils/time";
import {
  groupAgents,
  parseRepoNameFromRemoteUrl,
  parseRepoShortNameFromRemoteUrl,
} from "@/utils/agent-grouping";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  type CheckoutStatusPayload,
  checkoutStatusQueryKey,
  useCheckoutStatusCacheOnly,
  CHECKOUT_STATUS_STALE_TIME,
} from "@/hooks/use-checkout-status-query";
import {
  buildAgentNavigationKey,
  startNavigationTiming,
} from "@/utils/navigation-timing";
import {
  useSectionOrderStore,
  sortProjectsByStoredOrder,
} from "@/stores/section-order-store";
import { useProjectIconQuery } from "@/hooks/use-project-icon-query";

interface SectionData {
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

interface GroupedAgentListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}

interface SectionHeaderProps {
  section: SectionData;
  isCollapsed: boolean;
  onToggle: () => void;
  onCreateAgent: (workingDir: string) => void;
  onDrag: () => void;
  isDragging: boolean;
}

function SectionHeader({
  section,
  isCollapsed,
  onToggle,
  onCreateAgent,
  onDrag,
  isDragging,
}: SectionHeaderProps) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);

  // For project sections, try to get repo name from checkout status
  const checkoutQuery = useCheckoutStatusCacheOnly({
    serverId: section.firstAgentServerId ?? "",
    agentId: section.firstAgentId ?? "",
    cwd: section.workingDir ?? "",
  });
  const checkout = checkoutQuery.data ?? null;

  // Get project icon
  const iconQuery = useProjectIconQuery({
    serverId: section.firstAgentServerId ?? "",
    cwd: section.workingDir ?? "",
  });
  const icon = iconQuery.icon;

  // Derive display title: prefer repo name from remote URL, fallback to path-based name
  let displayTitle = section.title;
  if (checkout?.isGit && checkout.remoteUrl) {
    const isGitHubRemote =
      checkout.remoteUrl.includes("github.com") ||
      checkout.remoteUrl.includes("git@github.com:");

    const repoName = isGitHubRemote
      ? parseRepoNameFromRemoteUrl(checkout.remoteUrl)
      : parseRepoShortNameFromRemoteUrl(checkout.remoteUrl);

    if (repoName) {
      displayTitle = repoName;
    }
  }

  const handleCreatePress = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      if (section.workingDir) {
        onCreateAgent(section.workingDir);
      }
    },
    [onCreateAgent, section.workingDir]
  );

  return (
    <Pressable
      style={({ pressed }) => [
        styles.sectionHeader,
        isHovered && styles.sectionHeaderHovered,
        pressed && styles.sectionHeaderPressed,
        !isCollapsed && styles.sectionHeaderExpanded,
        isDragging && styles.sectionHeaderDragging,
      ]}
      onPress={onToggle}
      onLongPress={onDrag}
      delayLongPress={200}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
    >
      <View style={styles.sectionHeaderLeft}>
        {icon && (
          <Image
            source={{ uri: `data:${icon.mimeType};base64,${icon.data}` }}
            style={styles.projectIcon}
          />
        )}
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {displayTitle}
        </Text>
      </View>
      <View style={styles.sectionHeaderRight}>
        {section.workingDir && (
          <Pressable
            style={styles.createAgentButton}
            onPress={handleCreatePress}
            onHoverIn={() => setIsHovered(true)}
            onHoverOut={() => setIsHovered(true)}
          >
            {({ hovered }) => (
              <Plus
                size={14}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        )}
        {isCollapsed ? (
          <ChevronRight size={14} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        )}
      </View>
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
  parentGestureRef,
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

  const handleCreateAgentInProject = useCallback(
    (workingDir: string) => {
      router.push(`/agent?workingDir=${encodeURIComponent(workingDir)}` as any);
    },
    []
  );

  // Prefetch checkout status for all agents in the sidebar.
  // The sidebar shows a limited number of agents, so we fetch all of them upfront
  // to ensure project grouping (by remote URL) is stable from the start.
  useEffect(() => {
    for (const agent of agents) {
      const session = useSessionStore.getState().sessions[agent.serverId];
      const client = session?.client ?? null;
      const isConnected = session?.connection.isConnected ?? false;
      if (!client || !isConnected) {
        continue;
      }

      const queryKey = checkoutStatusQueryKey(agent.serverId, agent.cwd);
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
  }, [agents, queryClient]);

  // Subscribe to checkout status cache entries so project grouping can react
  // to remote URL updates (e.g. git worktrees in different directories).
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

  // Section order from store
  const projectOrder = useSectionOrderStore((state) => state.projectOrder);
  const setProjectOrder = useSectionOrderStore((state) => state.setProjectOrder);

  // Group agents
  const { activeGroups } = useMemo(
    () =>
      groupAgents(agents, {
        getRemoteUrl: (agent) =>
          remoteUrlByAgentKey.get(`${agent.serverId}:${agent.id}`) ?? null,
      }),
    [agents, remoteUrlByAgentKey]
  );

  // Sort groups by persisted order
  const sortedGroups = useMemo(
    () => sortProjectsByStoredOrder(activeGroups, projectOrder),
    [activeGroups, projectOrder]
  );

  // Build sections for DraggableFlatList
  const sections: SectionData[] = useMemo(() => {
    const result: SectionData[] = [];

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

  // Sync section order when new projects appear
  useEffect(() => {
    const currentKeys = sections.map((s) => s.projectKey);
    const storedKeys = new Set(projectOrder);
    const newKeys = currentKeys.filter((key) => !storedKeys.has(key));

    if (newKeys.length > 0) {
      // Add new projects at the end of the stored order
      setProjectOrder([...projectOrder, ...newKeys]);
    }
  }, [sections, projectOrder, setProjectOrder]);

  const handleDragEnd = useCallback(
    (newData: SectionData[]) => {
      const newOrder = newData.map((section) => section.projectKey);
      setProjectOrder(newOrder);
    },
    [setProjectOrder]
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
        cwd: agent.cwd,
      });
      const checkout = checkoutQuery.data ?? null;
      const activeBranchLabel = checkout?.isGit
        ? (checkout.currentBranch ?? checkout.baseRef ?? "git")
        : null;

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
                {activeBranchLabel ? `${activeBranchLabel} · ${timeAgo}` : timeAgo}
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

  const renderSection = useCallback(
    ({ item: section, drag, isActive }: DraggableRenderItemInfo<SectionData>) => {
      const isCollapsed = collapsedSections.has(section.key);

      return (
        <View style={isActive && styles.sectionDragging}>
          <SectionHeader
            section={section}
            isCollapsed={isCollapsed}
            onToggle={() => toggleSection(section.key)}
            onCreateAgent={handleCreateAgentInProject}
            onDrag={drag}
            isDragging={isActive}
          />
          {!isCollapsed &&
            section.agents.map((agent) => (
              <AgentListRow key={`${agent.serverId}:${agent.id}`} agent={agent} />
            ))}
        </View>
      );
    },
    [AgentListRow, collapsedSections, handleCreateAgentInProject, toggleSection]
  );

  const keyExtractor = useCallback(
    (section: SectionData) => section.key,
    []
  );

  return (
    <>
      <DraggableList
        data={sections}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderSection}
        onDragEnd={handleDragEnd}
        showsVerticalScrollIndicator={false}
        ListFooterComponent={listFooterComponent}
        refreshing={isRefreshing}
        onRefresh={onRefresh}
        simultaneousGestureRef={parentGestureRef}
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
    paddingHorizontal: theme.spacing[3],
    marginHorizontal: -theme.spacing[2],
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  sectionHeaderHovered: {
    backgroundColor: theme.colors.surface1,
  },
  sectionHeaderPressed: {
    backgroundColor: theme.colors.surface2,
  },
  sectionHeaderExpanded: {
    marginBottom: theme.spacing[1],
  },
  sectionHeaderDragging: {
    backgroundColor: theme.colors.surface2,
  },
  sectionDragging: {
    opacity: 0.9,
  },
  sectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  projectIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
  },
  sectionHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginLeft: theme.spacing[2],
  },
  createAgentButton: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "normal",
    color: theme.colors.foregroundMuted,
    flex: 1,
    textAlign: "left",
  },
  agentItem: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginHorizontal: -theme.spacing[2],
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
