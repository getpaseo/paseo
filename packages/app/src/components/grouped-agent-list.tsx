import {
  View,
  Text,
  Pressable,
  Modal,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import {
  DraggableList,
  type DraggableRenderItemInfo,
} from "./draggable-list";
import { formatTimeAgo } from "@/utils/time";
import { parseRepoNameFromRemoteUrl, parseRepoShortNameFromRemoteUrl } from "@/utils/agent-grouping";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  CHECKOUT_STATUS_STALE_TIME,
  checkoutStatusQueryKey,
  useCheckoutStatusCacheOnly,
} from "@/hooks/use-checkout-status-query";
import {
  buildAgentNavigationKey,
  startNavigationTiming,
} from "@/utils/navigation-timing";
import {
  useSectionOrderStore,
} from "@/stores/section-order-store";
import { useProjectIconQuery } from "@/hooks/use-project-icon-query";
import { useSidebarAgentSections, type SidebarSectionData } from "@/hooks/use-sidebar-agent-sections";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
import { getIsTauri } from "@/constants/layout";
import { AgentStatusDot } from "@/components/agent-status-dot";

type SectionData = SidebarSectionData;

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

  const createAgentWorkingDir =
    (checkout?.isPaseoOwnedWorktree ? checkout.mainRepoRoot : null) ?? section.workingDir;

  const handleCreatePress = useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      if (createAgentWorkingDir) {
        onCreateAgent(createAgentWorkingDir);
      }
    },
    [onCreateAgent, createAgentWorkingDir]
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
        <View style={styles.chevron}>
          {isCollapsed ? (
            <ChevronRight size={14} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          )}
        </View>
        {icon ? (
          <Image
            source={{ uri: `data:${icon.mimeType};base64,${icon.data}` }}
            style={styles.projectIcon}
          />
        ) : (
          <View style={styles.projectIconPlaceholder}>
            <Text style={styles.projectIconPlaceholderText}>
              {(section.workingDir?.split("/").pop() ?? displayTitle).charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {displayTitle}
        </Text>
      </View>
      <View style={styles.sectionHeaderRight}>
        {createAgentWorkingDir && (
          <Pressable
            style={styles.createAgentButton}
            onPress={handleCreatePress}
            hitSlop={20}
            onStartShouldSetResponder={() => true}
            onStartShouldSetResponderCapture={() => true}
          >
            {({ hovered, pressed }) => (
              <Plus
                size={18}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
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
  const insets = useSafeAreaInsets();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);

  const collapsedProjectKeys = useSidebarCollapsedSectionsStore((s) => s.collapsedProjectKeys);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore((s) => s.toggleProjectCollapsed);

  const altDown = useKeyboardNavStore((s) => s.altDown);
  const cmdOrCtrlDown = useKeyboardNavStore((s) => s.cmdOrCtrlDown);
  const sidebarShortcutAgentKeys = useKeyboardNavStore((s) => s.sidebarShortcutAgentKeys);
  const isTauri = getIsTauri();
  const showShortcutBadges = altDown || (isTauri && cmdOrCtrlDown);
  const shortcutIndexByAgentKey = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < sidebarShortcutAgentKeys.length; i++) {
      const key = sidebarShortcutAgentKeys[i];
      if (!key) continue;
      map.set(key, i + 1);
    }
    return map;
  }, [sidebarShortcutAgentKeys]);

  const actionClient = useSessionStore((state) =>
    actionAgent?.serverId ? state.sessions[actionAgent.serverId]?.client ?? null : null
  );

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !actionClient);

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

  const handleArchiveFromSheet = useCallback(() => {
    if (!actionAgent || !actionClient) {
      return;
    }
    void actionClient.archiveAgent(actionAgent.id);
    setActionAgent(null);
  }, [actionAgent, actionClient]);

  const handleCreateAgentInProject = useCallback(
    (workingDir: string) => {
      onAgentSelect?.();
      router.push(`/agent?workingDir=${encodeURIComponent(workingDir)}` as any);
    },
    [onAgentSelect]
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
        queryFn: async () => await client.getCheckoutStatus(agent.cwd),
        staleTime: CHECKOUT_STATUS_STALE_TIME,
      }).catch((error) => {
        console.warn("[checkout_status] prefetch failed", error);
      });
    }
  }, [agents, queryClient]);

  // Section order from store
  const setProjectOrder = useSectionOrderStore((state) => state.setProjectOrder);

  const sections: SectionData[] = useSidebarAgentSections(agents);

  const handleDragEnd = useCallback(
    (newData: SectionData[]) => {
      const newOrder = newData.map((section) => section.projectKey);
      setProjectOrder(newOrder);
    },
    [setProjectOrder]
  );

  const handleArchiveAgent = useCallback(
    (e: { stopPropagation: () => void }, agent: AggregatedAgent) => {
      e.stopPropagation();
      const session = useSessionStore.getState().sessions[agent.serverId];
      const client = session?.client ?? null;
      if (client) {
        void client.archiveAgent(agent.id).catch((error) => {
          console.warn("[archive_agent] failed", error);
        });
      }
    },
    []
  );

  const AgentListRow = useCallback(
    ({ agent }: { agent: AggregatedAgent }) => {
      const [isHovered, setIsHovered] = useState(false);
      const timeAgo = formatTimeAgo(agent.lastActivityAt);
      const agentKey = `${agent.serverId}:${agent.id}`;
      const isSelected = selectedAgentId === agentKey;
      const isRunning = agent.status === "running";
      const shortcutNumber =
        showShortcutBadges ? (shortcutIndexByAgentKey.get(agentKey) ?? null) : null;

      const checkoutQuery = useCheckoutStatusCacheOnly({
        serverId: agent.serverId,
        cwd: agent.cwd,
      });
      const checkout = checkoutQuery.data ?? null;
      const activeBranchLabel = checkout?.isGit
        ? ((checkout.currentBranch && checkout.currentBranch !== "HEAD"
            ? checkout.currentBranch
            : null) ??
          checkout.baseRef ??
          "git")
        : null;

      const canArchive = !isRunning && !agent.requiresAttention;

      return (
        <Pressable
          style={({ pressed }) => [
            styles.agentItem,
            !isSelected && styles.agentItemUnselected,
            isSelected && styles.agentItemSelected,
            isHovered && styles.agentItemHovered,
            pressed && styles.agentItemPressed,
          ]}
          onPress={() => handleAgentPress(agent.serverId, agent.id)}
          onLongPress={() => handleAgentLongPress(agent)}
          onHoverIn={() => setIsHovered(true)}
          onHoverOut={() => setIsHovered(false)}
          testID={`agent-row-${agent.serverId}-${agent.id}`}
        >
          <View style={styles.agentContent}>
            <View style={styles.row}>
              <AgentStatusDot status={agent.status} requiresAttention={agent.requiresAttention} />
              <Text
                style={[
                  styles.agentTitle,
                  (isSelected || isHovered) && styles.agentTitleHighlighted,
                ]}
                numberOfLines={1}
              >
                {agent.title || "New agent"}
              </Text>
              {shortcutNumber !== null ? (
                <View style={styles.branchBadge}>
                  <Text style={styles.branchBadgeText} numberOfLines={1}>
                    {shortcutNumber}
                  </Text>
                </View>
              ) : isHovered && canArchive ? (
                <Pressable
                  style={styles.branchBadge}
                  onPress={(e) => handleArchiveAgent(e, agent)}
                  onHoverIn={() => setIsHovered(true)}
                  onHoverOut={() => setIsHovered(true)}
                  testID={`agent-archive-${agent.serverId}-${agent.id}`}
                >
                  {({ hovered: archiveHovered }) => (
                    <Archive
                      size={12}
                      color={
                        archiveHovered
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  )}
                </Pressable>
              ) : activeBranchLabel ? (
                <View style={styles.branchBadge}>
                  <Text style={styles.branchBadgeText} numberOfLines={1}>
                    {activeBranchLabel}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </Pressable>
      );
    },
    [
      handleAgentLongPress,
      handleAgentPress,
      handleArchiveAgent,
      selectedAgentId,
      showShortcutBadges,
      shortcutIndexByAgentKey,
      theme.colors.foreground,
      theme.colors.foregroundMuted,
    ]
  );

  const renderSection = useCallback(
    ({ item: section, drag, isActive }: DraggableRenderItemInfo<SectionData>) => {
      const isCollapsed = collapsedProjectKeys.has(section.projectKey);

      return (
        <View style={[styles.sectionContainer, isActive && styles.sectionDragging]}>
          <SectionHeader
            section={section}
            isCollapsed={isCollapsed}
            onToggle={() => toggleProjectCollapsed(section.projectKey)}
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
    [AgentListRow, collapsedProjectKeys, handleCreateAgentInProject, toggleProjectCollapsed]
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
          <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, theme.spacing[6]) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {isActionDaemonUnavailable
                ? "Host offline"
                : "Archive this agent?"}
            </Text>
            <View style={styles.sheetButtonRow}>
              <Pressable
                style={[styles.sheetButton, styles.sheetCancelButton]}
                onPress={handleCloseActionSheet}
                testID="agent-action-cancel"
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={isActionDaemonUnavailable}
                style={[styles.sheetButton, styles.sheetArchiveButton]}
                onPress={handleArchiveFromSheet}
                testID="agent-action-archive"
              >
                <Text
                  style={[
                    styles.sheetArchiveText,
                    isActionDaemonUnavailable && styles.sheetArchiveTextDisabled,
                  ]}
                >
                  Archive
                </Text>
              </Pressable>
            </View>
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
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
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
    marginBottom: theme.spacing[2],
  },
  sectionHeaderDragging: {
    backgroundColor: theme.colors.surface2,
  },
  sectionContainer: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  sectionDragging: {
    opacity: 0.9,
    transform: [{ scale: 1.02 }],
  },
  chevron: {
    opacity: 0.5,
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
  projectIconPlaceholder: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconPlaceholderText: {
    fontSize: 10,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  sectionHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginLeft: theme.spacing[2],
  },
  createAgentButton: {
    width: 18,
    height: 18,
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
    marginLeft: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
  },
  agentItemUnselected: {
    opacity: 0.75,
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
    fontWeight: "400",
    color: theme.colors.foreground,
    opacity: 0.8,
  },
  archiveButton: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[1],
  },
  branchBadge: {
    minWidth: 20,
    maxWidth: "40%",
    height: 20,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  branchBadgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 12,
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
    gap: theme.spacing[4],
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.3,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  sheetButtonRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  sheetButton: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  sheetArchiveButton: {
    backgroundColor: theme.colors.primary,
  },
  sheetArchiveText: {
    color: theme.colors.primaryForeground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
  sheetArchiveTextDisabled: {
    opacity: 0.5,
  },
  sheetCancelButton: {
    backgroundColor: theme.colors.surface1,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
}));
