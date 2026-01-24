import {
  View,
  Text,
  Pressable,
  Modal,
  RefreshControl,
  FlatList,
  type ViewToken,
  type ListRenderItem,
} from "react-native";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { router, usePathname } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  CHECKOUT_STATUS_STALE_TIME,
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
  useCheckoutStatusCacheOnly,
} from "@/hooks/use-checkout-status-query";
import {
  buildAgentNavigationKey,
  startNavigationTiming,
} from "@/utils/navigation-timing";

interface AgentListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
}

export function AgentList({
  agents,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
}: AgentListProps) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);

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

      navigate({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId,
          agentId,
        },
      });
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

  const deriveBranchLabel = useCallback((checkout: CheckoutStatusPayload | null): string | null => {
    if (!checkout || !checkout.isGit) {
      return null;
    }
    const currentBranch: string | null = checkout.currentBranch ?? null;
    const baseRef: string | null = checkout.baseRef ?? null;
    if (!currentBranch) {
      return null;
    }
    if (baseRef && currentBranch === baseRef) {
      return null;
    }
    return currentBranch;
  }, []);

  const deriveProjectPath = useCallback(
    (agent: AggregatedAgent, checkout: CheckoutStatusPayload | null): string => {
      const basePath = checkout?.isGit ? (checkout.repoRoot ?? agent.cwd) : agent.cwd;
      const worktreeMarker = ".paseo/worktrees/";
      const idx = basePath.indexOf(worktreeMarker);
      if (idx !== -1) {
        const afterMarker = basePath.slice(idx + worktreeMarker.length);
        const slashIdx = afterMarker.indexOf("/");
        if (slashIdx !== -1) {
          return afterMarker.slice(slashIdx + 1);
        }
        return afterMarker;
      }
      return basePath;
    },
    []
  );

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
      const projectPath = deriveProjectPath(agent, checkout);
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
      deriveBranchLabel,
      deriveProjectPath,
      handleAgentLongPress,
      handleAgentPress,
      selectedAgentId,
      theme.colors.palette.blue,
      theme.colors.success,
    ]
  );

  const renderAgentItem = useCallback<ListRenderItem<AggregatedAgent>>(
    ({ item: agent }) => <AgentListRow agent={agent} />,
    [AgentListRow]
  );

  const keyExtractor = useCallback(
    (agent: AggregatedAgent) => `${agent.serverId}:${agent.id}`,
    []
  );

  return (
    <>
      <FlatList
        data={agents}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderAgentItem}
        extraData={selectedAgentId}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={16}
        removeClippedSubviews={true}
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
