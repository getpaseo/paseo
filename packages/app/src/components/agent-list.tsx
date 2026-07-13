import {
  View,
  Text,
  Pressable,
  RefreshControl,
  FlatList,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTimeAgo } from "@/utils/time";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { Archive, ChevronRight, MoreVertical, Pin, PinOff } from "lucide-react-native";
import { getProviderIcon } from "@/components/provider-icons";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useQueryClient } from "@tanstack/react-query";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "@/hooks/agent-history-query-key";
import type { HistorySection, HistoryDateSectionKey } from "@/hooks/history-view-model";
import { HistoryAgentActionMenu } from "@/components/history-agent-action-menu";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useToast } from "@/contexts/toast-context";

interface AgentListProps {
  sections: HistorySection[];
  showCheckoutInfo?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  showAttentionIndicator?: boolean;
  showHostColumn?: boolean;
}

type FlatListItem =
  | { type: "header"; key: string; section: Exclude<HistorySection, { kind: "none" }> }
  | { type: "agent"; key: string; agent: AggregatedAgent };

const ACTION_SHEET_SNAP_POINTS = ["45%", "75%"];

function formatDateSectionLabel(t: TFunction, section: HistoryDateSectionKey): string {
  switch (section) {
    case "today":
      return t("agentList.dateSections.today");
    case "yesterday":
      return t("agentList.dateSections.yesterday");
    case "thisWeek":
      return t("agentList.dateSections.thisWeek");
    case "thisMonth":
      return t("agentList.dateSections.thisMonth");
    case "older":
      return t("agentList.dateSections.older");
  }
}

function formatSectionLabel(
  t: TFunction,
  section: Exclude<HistorySection, { kind: "none" }>,
): string {
  if (section.kind === "pinned") return t("agentList.sections.pinned");
  if (section.kind === "project") return section.title;
  return formatDateSectionLabel(t, section.dateKey);
}

function SessionBadge({
  label,
  icon,
  tone = "neutral",
}: {
  label: string;
  icon?: ReactElement;
  tone?: "neutral" | "warning" | "danger";
}) {
  const badgeStyle = useMemo(
    () => [
      styles.badge,
      tone === "warning" && styles.badgeWarning,
      tone === "danger" && styles.badgeDanger,
    ],
    [tone],
  );
  const badgeTextStyle = useMemo(
    () => [
      styles.badgeText,
      tone === "warning" && styles.badgeTextWarning,
      tone === "danger" && styles.badgeTextDanger,
    ],
    [tone],
  );
  return (
    <View style={badgeStyle}>
      {icon}
      <Text style={badgeTextStyle}>{label}</Text>
    </View>
  );
}

function WorkspaceTitlePrefix({
  visible,
  workspaceName,
  testID,
  iconSize,
  color,
}: {
  visible: boolean;
  workspaceName: string;
  testID: string;
  iconSize: number;
  color: string;
}) {
  if (!visible) {
    return null;
  }

  return (
    <>
      <Text style={styles.workspaceTitleText} numberOfLines={1} testID={testID}>
        {workspaceName}
      </Text>
      <ChevronRight size={iconSize} color={color} />
    </>
  );
}

function SessionRowBadges({
  agent,
  archivedIcon,
  pendingPermissionCount,
  showDesktopAttention,
}: {
  agent: AggregatedAgent;
  archivedIcon: ReactElement;
  pendingPermissionCount: number;
  showDesktopAttention: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {agent.archivedAt ? (
        <SessionBadge label={t("agentList.badges.archived")} icon={archivedIcon} />
      ) : null}
      {pendingPermissionCount > 0 ? (
        <SessionBadge
          label={t("agentList.badges.pending", { count: pendingPermissionCount })}
          tone="warning"
        />
      ) : null}
      {showDesktopAttention ? (
        <SessionBadge label={t("agentList.badges.attention")} tone="danger" />
      ) : null}
    </>
  );
}

function SessionRowTrailingAttention({
  isMobile,
  showAttentionIndicator,
  requiresAttention,
}: {
  isMobile: boolean;
  showAttentionIndicator: boolean;
  requiresAttention: boolean | undefined;
}) {
  const { t } = useTranslation();
  if (!isMobile || !showAttentionIndicator || !requiresAttention) {
    return null;
  }
  return (
    <View style={styles.rowTrailing}>
      <SessionBadge label={t("agentList.badges.attention")} tone="danger" />
    </View>
  );
}

function SessionRow({
  agent,
  isMobile,
  selectedAgentId,
  showAttentionIndicator,
  showHostColumn,
  onPress,
  onOpenActions,
  onTogglePin,
  onArchive,
  actionPending,
}: {
  agent: AggregatedAgent;
  isMobile: boolean;
  selectedAgentId?: string;
  showAttentionIndicator: boolean;
  showHostColumn: boolean;
  onPress: (agent: AggregatedAgent) => void;
  onOpenActions: (agent: AggregatedAgent) => void;
  onTogglePin: (agent: AggregatedAgent) => void;
  onArchive: (agent: AggregatedAgent) => void;
  actionPending: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const timeAgo = formatTimeAgo(agent.lastActivityAt);
  const agentKey = `${agent.serverId}:${agent.id}`;
  const isSelected = selectedAgentId === agentKey;
  const projectName = agent.projectPlacement?.projectName ?? "";
  const branch = agent.projectPlacement?.checkout.currentBranch ?? "";
  const workspaceName = agent.projectPlacement?.workspaceName ?? "";
  const ProviderIcon = getProviderIcon(agent.provider);
  const pendingPermissionCount = agent.pendingPermissionCount ?? 0;

  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      isSelected && styles.rowSelected,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isSelected],
  );

  const handlePress = useCallback(() => onPress(agent), [onPress, agent]);
  const handleOpenActions = useCallback(() => onOpenActions(agent), [onOpenActions, agent]);

  const sessionTitleStyle = useMemo(
    () => [styles.sessionTitle, isSelected && styles.sessionTitleHighlighted],
    [isSelected],
  );
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);

  const archivedIcon = useMemo(
    () => <Archive size={theme.fontSize.xs} color={theme.colors.foregroundMuted} />,
    [theme.fontSize.xs, theme.colors.foregroundMuted],
  );
  const showDesktopAttention =
    !isMobile && showAttentionIndicator && Boolean(agent.requiresAttention);

  return (
    <View style={styles.rowFrame}>
      <Pressable
        style={pressableStyle}
        onPress={handlePress}
        onLongPress={handleOpenActions}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        testID={`agent-row-${agent.serverId}-${agent.id}`}
      >
        <View style={styles.rowContent}>
          <View style={styles.rowTitleRow}>
            <WorkspaceTitlePrefix
              visible={!isMobile && Boolean(workspaceName)}
              workspaceName={workspaceName}
              testID={`agent-row-workspace-${agent.serverId}-${agent.id}`}
              iconSize={theme.iconSize.xs}
              color={theme.colors.foregroundMuted}
            />
            <View style={styles.providerIconWrap}>
              <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            </View>
            <Text style={sessionTitleStyle} numberOfLines={1}>
              {agent.title || t("agentList.fallbackTitle")}
            </Text>
            <SessionRowBadges
              agent={agent}
              archivedIcon={archivedIcon}
              pendingPermissionCount={pendingPermissionCount}
              showDesktopAttention={showDesktopAttention}
            />
          </View>
          {isMobile ? (
            <View style={styles.rowMetaRow}>
              <Text
                style={styles.sessionMetaText}
                numberOfLines={1}
                testID={`agent-row-project-${agent.serverId}-${agent.id}`}
              >
                {projectName}
              </Text>
              <Text style={styles.sessionMetaSeparator}>·</Text>
              <Text
                style={styles.sessionMetaText}
                numberOfLines={1}
                testID={`agent-row-branch-${agent.serverId}-${agent.id}`}
              >
                {branch}
              </Text>
              <Text style={styles.sessionMetaSeparator}>·</Text>
              <Text
                style={styles.sessionMetaText}
                numberOfLines={1}
                testID={`agent-row-workspace-${agent.serverId}-${agent.id}`}
              >
                {workspaceName}
              </Text>
              <Text style={styles.sessionMetaSeparator}>·</Text>
              <Text style={styles.sessionMetaText}>{timeAgo}</Text>
              {showHostColumn && agent.serverLabel ? (
                <>
                  <Text style={styles.sessionMetaSeparator}>·</Text>
                  <Text style={styles.sessionMetaText} numberOfLines={1}>
                    {agent.serverLabel}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
        </View>
        {!isMobile ? (
          <View style={styles.rowColumns}>
            <Text
              style={styles.columnMeta}
              numberOfLines={1}
              testID={`agent-row-project-${agent.serverId}-${agent.id}`}
            >
              {projectName}
            </Text>
            {showHostColumn ? (
              <Text style={styles.columnMetaHost} numberOfLines={1}>
                {agent.serverLabel}
              </Text>
            ) : null}
            <Text
              style={styles.columnMeta}
              numberOfLines={1}
              testID={`agent-row-branch-${agent.serverId}-${agent.id}`}
            >
              {branch}
            </Text>
            <Text style={styles.columnMetaFixed} numberOfLines={1}>
              {timeAgo}
            </Text>
          </View>
        ) : null}
        <SessionRowTrailingAttention
          isMobile={isMobile}
          showAttentionIndicator={showAttentionIndicator}
          requiresAttention={agent.requiresAttention}
        />
      </Pressable>
      <View style={styles.rowActionSlot}>
        {isMobile ? (
          <Button
            variant="ghost"
            size="xs"
            leftIcon={MoreVertical}
            onPress={handleOpenActions}
            accessibilityLabel={t("agentList.actions.menuAccessibility", {
              title: agent.title || t("agentList.actions.fallbackSession"),
            })}
            testID={`history-agent-actions-${agent.serverId}-${agent.id}`}
          />
        ) : (
          <HistoryAgentActionMenu
            agent={agent}
            pending={actionPending}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
          />
        )}
      </View>
    </View>
  );
}

export function AgentList({
  sections,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
  showAttentionIndicator = true,
  showHostColumn = false,
}: AgentListProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const isMobile = useIsCompactFormFactor();
  const { archiveAgent } = useArchiveAgent();
  const toast = useToast();
  const queryClient = useQueryClient();
  const actionSupportsPinning = useHostFeature(actionAgent?.serverId, "agentPinning");

  const actionClient = useSessionStore((state) =>
    actionAgent?.serverId ? (state.sessions[actionAgent.serverId]?.client ?? null) : null,
  );

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !actionClient);
  const actionSheetHeader = useMemo(
    () => ({
      title: t("agentList.actions.sheetTitle"),
      subtitle: actionAgent?.title || t("agentList.fallbackTitle"),
    }),
    [actionAgent?.title, t],
  );
  let actionPinLabel = t("agentList.actions.updateHostToPin");
  if (actionSupportsPinning) {
    actionPinLabel = actionAgent?.pinnedAt
      ? t("agentList.actions.unpin")
      : t("agentList.actions.pin");
  }

  const invalidateAgentHistory = useCallback(
    async (serverId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(serverId) }),
        queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() }),
      ]);
    },
    [queryClient],
  );

  const handleAgentPress = useCallback(
    (agent: AggregatedAgent) => {
      if (isActionSheetVisible) {
        return;
      }

      const serverId = agent.serverId;
      const agentId = agent.id;
      const openAgent = () => {
        onAgentSelect?.();
        navigateToAgent({
          serverId,
          agentId,
          workspaceId: agent.workspaceId,
          pin: false,
        });
      };

      if (agent.archivedAt) {
        const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
        if (client) {
          void client
            .refreshAgent(agentId)
            .then(() => {
              openAgent();
              return invalidateAgentHistory(serverId);
            })
            .catch(() => {});
        }
        return;
      }

      openAgent();
    },
    [invalidateAgentHistory, isActionSheetVisible, onAgentSelect],
  );

  const handleOpenActions = useCallback((agent: AggregatedAgent) => {
    setActionAgent(agent);
  }, []);

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleTogglePin = useCallback(
    (agent: AggregatedAgent) => {
      const client = useSessionStore.getState().sessions[agent.serverId]?.client ?? null;
      if (!client) {
        setActionAgent(agent);
        return;
      }
      const actionKey = `${agent.serverId}:${agent.id}`;
      setPendingActionKey(actionKey);
      void client
        .setAgentPinned(agent.id, !agent.pinnedAt)
        .then(() => invalidateAgentHistory(agent.serverId))
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("agentList.actions.updatePinFailed"),
          );
        })
        .finally(() => setPendingActionKey((current) => (current === actionKey ? null : current)));
    },
    [invalidateAgentHistory, t, toast],
  );

  const handleRequestArchive = useCallback((agent: AggregatedAgent) => {
    setActionAgent(agent);
  }, []);

  const handleArchiveAgent = useCallback(() => {
    if (!actionAgent || !actionClient) return;
    const actionKey = `${actionAgent.serverId}:${actionAgent.id}`;
    setPendingActionKey(actionKey);
    void archiveAgent({ serverId: actionAgent.serverId, agentId: actionAgent.id })
      .catch(() => {})
      .finally(() => setPendingActionKey((current) => (current === actionKey ? null : current)));
    setActionAgent(null);
  }, [actionAgent, actionClient, archiveAgent]);

  const handleSheetTogglePin = useCallback(() => {
    if (!actionAgent || !actionSupportsPinning || !actionClient) return;
    handleTogglePin(actionAgent);
    setActionAgent(null);
  }, [actionAgent, actionClient, actionSupportsPinning, handleTogglePin]);

  const flatItems = useMemo((): FlatListItem[] => {
    const result: FlatListItem[] = [];
    for (const section of sections) {
      if (section.kind !== "none") {
        result.push({ type: "header", key: `header:${section.key}`, section });
      }
      for (const agent of section.agents) {
        result.push({ type: "agent", key: `${agent.serverId}:${agent.id}`, agent });
      }
    }
    return result;
  }, [sections]);

  const renderItem: ListRenderItem<FlatListItem> = useCallback(
    ({ item }) => {
      if (item.type === "header") {
        return (
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{formatSectionLabel(t, item.section)}</Text>
          </View>
        );
      }
      return (
        <SessionRow
          agent={item.agent}
          isMobile={isMobile}
          selectedAgentId={selectedAgentId}
          showAttentionIndicator={showAttentionIndicator}
          showHostColumn={showHostColumn}
          onPress={handleAgentPress}
          onOpenActions={handleOpenActions}
          onTogglePin={handleTogglePin}
          onArchive={handleRequestArchive}
          actionPending={pendingActionKey === `${item.agent.serverId}:${item.agent.id}`}
        />
      );
    },
    [
      handleAgentPress,
      handleOpenActions,
      handleRequestArchive,
      handleTogglePin,
      isMobile,
      pendingActionKey,
      selectedAgentId,
      showAttentionIndicator,
      showHostColumn,
      t,
    ],
  );

  const keyExtractor = useCallback((item: FlatListItem) => item.key, []);

  const refreshColors = useMemo(
    () => [theme.colors.foregroundMuted],
    [theme.colors.foregroundMuted],
  );
  const refreshControl = useMemo(
    () =>
      onRefresh ? (
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.foregroundMuted}
          colors={refreshColors}
        />
      ) : undefined,
    [onRefresh, isRefreshing, theme.colors.foregroundMuted, refreshColors],
  );

  return (
    <>
      <FlatList
        data={flatItems}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={listFooterComponent}
        refreshControl={refreshControl}
      />

      <AdaptiveModalSheet
        visible={isActionSheetVisible}
        onClose={handleCloseActionSheet}
        header={actionSheetHeader}
        snapPoints={ACTION_SHEET_SNAP_POINTS}
        scrollable={false}
        testID="history-agent-action-sheet"
      >
        <View style={styles.sheetActions}>
          <Button
            variant="secondary"
            leftIcon={actionAgent?.pinnedAt ? PinOff : Pin}
            disabled={
              !actionSupportsPinning ||
              isActionDaemonUnavailable ||
              (actionAgent
                ? pendingActionKey === `${actionAgent.serverId}:${actionAgent.id}`
                : false)
            }
            onPress={handleSheetTogglePin}
            testID="agent-action-pin"
          >
            {actionPinLabel}
          </Button>
          {!actionAgent?.archivedAt ? (
            <Button
              variant="outline"
              leftIcon={Archive}
              disabled={isActionDaemonUnavailable}
              onPress={handleArchiveAgent}
              testID="agent-action-archive"
            >
              {t("agentList.actions.archive")}
            </Button>
          ) : null}
          <Button variant="ghost" onPress={handleCloseActionSheet} testID="agent-action-cancel">
            {t("common.actions.cancel")}
          </Button>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[1],
  },
  sectionHeading: {
    marginTop: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  rowFrame: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: {
      xs: theme.borderRadius.lg,
      md: 0,
    },
    marginBottom: {
      xs: theme.spacing[1],
      md: 0,
    },
  },
  rowActionSlot: {
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: theme.spacing[2],
    overflow: "hidden",
  },
  providerIconWrap: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceTitleText: {
    flexShrink: 0,
    maxWidth: 220,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  rowTrailing: {
    marginLeft: theme.spacing[2],
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  sessionTitle: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    color: theme.colors.foreground,
    opacity: 0.86,
  },
  sessionTitleHighlighted: {
    opacity: 1,
  },
  sessionMetaText: {
    maxWidth: "100%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sessionMetaSeparator: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  rowColumns: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[3],
  },
  columnMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 132,
  },
  columnMetaFixed: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 72,
    textAlign: "right" as const,
  },
  columnMetaHost: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 120,
    marginLeft: theme.spacing[4],
    textAlign: "right" as const,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  badgeWarning: {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
  },
  badgeDanger: {
    backgroundColor: "rgba(239, 68, 68, 0.14)",
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  badgeTextWarning: {
    color: theme.colors.palette.amber[500],
  },
  badgeTextDanger: {
    color: theme.colors.palette.red[300],
  },
  sheetActions: {
    gap: theme.spacing[3],
  },
}));
