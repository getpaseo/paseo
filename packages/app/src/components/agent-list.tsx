import {
  View,
  Text,
  Pressable,
  Modal,
  RefreshControl,
  FlatList,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTimeAgo } from "@/utils/time";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { Archive, ChevronDown, ChevronRight } from "lucide-react-native";
import { getProviderIcon } from "@/components/provider-icons";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useQueryClient } from "@tanstack/react-query";
import { agentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import { buildFlatItems, formatDateSectionLabel, type FlatListItem } from "./agent-list-grouping";

interface AgentListProps {
  agents: AggregatedAgent[];
  showCheckoutInfo?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  showAttentionIndicator?: boolean;
  showHostColumn?: boolean;
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

const DISCLOSURE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

function RowLeadingControl({
  hasChildren,
  depth,
  expanded,
  onToggle,
  testID,
}: {
  hasChildren: boolean;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  testID: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  if (hasChildren) {
    return (
      <Pressable
        onPress={onToggle}
        hitSlop={DISCLOSURE_HIT_SLOP}
        style={styles.disclosureButton}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={t("subagents.toggle")}
        accessibilityState={accessibilityState}
      >
        {expanded ? (
          <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
    );
  }
  if (depth >= 1) {
    return <View style={styles.childIndent} />;
  }
  return null;
}

function SessionRowMobileMeta({
  agent,
  isMobile,
  projectName,
  branch,
  workspaceName,
  timeAgo,
  showHostColumn,
}: {
  agent: AggregatedAgent;
  isMobile: boolean;
  projectName: string;
  branch: string;
  workspaceName: string;
  timeAgo: string;
  showHostColumn: boolean;
}) {
  if (!isMobile) {
    return null;
  }
  return (
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
  );
}

function SessionRow({
  agent,
  isMobile,
  selectedAgentId,
  showAttentionIndicator,
  showHostColumn,
  onPress,
  onLongPress,
  depth = 0,
  hasChildren = false,
  expanded = false,
  childCount = 0,
  onToggleExpand,
}: {
  agent: AggregatedAgent;
  isMobile: boolean;
  selectedAgentId?: string;
  showAttentionIndicator: boolean;
  showHostColumn: boolean;
  onPress: (agent: AggregatedAgent) => void;
  onLongPress: (agent: AggregatedAgent) => void;
  depth?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  childCount?: number;
  onToggleExpand?: (agentKey: string) => void;
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

  const rowIndentStyle = useMemo(
    () => (depth > 0 ? { paddingLeft: theme.spacing[3] + depth * theme.spacing[4] } : null),
    [depth, theme.spacing],
  );

  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      rowIndentStyle,
      isSelected && styles.rowSelected,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isSelected, rowIndentStyle],
  );

  const handlePress = useCallback(() => onPress(agent), [onPress, agent]);
  const handleLongPress = useCallback(() => onLongPress(agent), [onLongPress, agent]);
  const handleToggleExpand = useCallback(() => {
    onToggleExpand?.(agentKey);
  }, [onToggleExpand, agentKey]);

  const sessionTitleStyle = useMemo(
    () => [styles.sessionTitle, isSelected && styles.sessionTitleHighlighted],
    [isSelected],
  );

  const archivedIcon = useMemo(
    () => <Archive size={theme.fontSize.xs} color={theme.colors.foregroundMuted} />,
    [theme.fontSize.xs, theme.colors.foregroundMuted],
  );
  const showDesktopAttention =
    !isMobile && showAttentionIndicator && Boolean(agent.requiresAttention);

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      onLongPress={handleLongPress}
      testID={`agent-row-${agent.serverId}-${agent.id}`}
    >
      <RowLeadingControl
        hasChildren={hasChildren}
        depth={depth}
        expanded={expanded}
        onToggle={handleToggleExpand}
        testID={`agent-row-disclosure-${agent.serverId}-${agent.id}`}
      />
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
          {hasChildren ? <SessionBadge label={String(childCount)} /> : null}
        </View>
        <SessionRowMobileMeta
          agent={agent}
          isMobile={isMobile}
          projectName={projectName}
          branch={branch}
          workspaceName={workspaceName}
          timeAgo={timeAgo}
          showHostColumn={showHostColumn}
        />
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
  );
}

export function AgentList({
  agents,
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
  const insets = useSafeAreaInsets();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const [expandedParents, setExpandedParents] = useState<ReadonlySet<string>>(new Set());
  const isMobile = useIsCompactFormFactor();
  const { archiveAgent } = useArchiveAgent();
  const queryClient = useQueryClient();

  const actionClient = useSessionStore((state) =>
    actionAgent?.serverId ? (state.sessions[actionAgent.serverId]?.client ?? null) : null,
  );

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !actionClient);

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
              return queryClient.invalidateQueries({
                queryKey: agentHistoryQueryKey(serverId),
              });
            })
            .catch(() => {});
        }
        return;
      }

      openAgent();
    },
    [isActionSheetVisible, onAgentSelect, queryClient],
  );

  const handleAgentLongPress = useCallback(
    (agent: AggregatedAgent) => {
      const isRunning = agent.status === "running";
      if (isRunning) {
        setActionAgent(agent);
        return;
      }

      const client = useSessionStore.getState().sessions[agent.serverId]?.client ?? null;
      if (!client) {
        setActionAgent(agent);
        return;
      }
      void archiveAgent({ serverId: agent.serverId, agentId: agent.id }).catch(() => {});
    },
    [archiveAgent],
  );

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleArchiveAgent = useCallback(() => {
    if (!actionAgent || !actionClient) {
      return;
    }
    // Timeout errors are swallowed — the daemon will still process the archive
    void archiveAgent({ serverId: actionAgent.serverId, agentId: actionAgent.id }).catch(() => {});
    setActionAgent(null);
  }, [actionAgent, actionClient, archiveAgent]);

  const handleToggleExpand = useCallback((agentKey: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(agentKey)) {
        next.delete(agentKey);
      } else {
        next.add(agentKey);
      }
      return next;
    });
  }, []);

  const flatItems = useMemo(
    () => buildFlatItems(agents, expandedParents),
    [agents, expandedParents],
  );

  const renderItem: ListRenderItem<FlatListItem> = useCallback(
    ({ item }) => {
      if (item.type === "header") {
        return (
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{formatDateSectionLabel(t, item.section)}</Text>
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
          onLongPress={handleAgentLongPress}
          depth={item.depth}
          hasChildren={item.hasChildren}
          expanded={item.expanded}
          childCount={item.childCount}
          onToggleExpand={handleToggleExpand}
        />
      );
    },
    [
      handleAgentLongPress,
      handleAgentPress,
      handleToggleExpand,
      isMobile,
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
  const sheetContainerStyle = useMemo(
    () => [styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, theme.spacing[6]) }],
    [insets.bottom, theme.spacing],
  );
  const sheetArchiveTextStyle = useMemo(
    () => [styles.sheetArchiveText, isActionDaemonUnavailable && styles.sheetArchiveTextDisabled],
    [isActionDaemonUnavailable],
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

      <Modal
        visible={isActionSheetVisible}
        animationType="fade"
        transparent
        onRequestClose={handleCloseActionSheet}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={styles.sheetBackdrop} onPress={handleCloseActionSheet} />
          <View style={sheetContainerStyle}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {isActionDaemonUnavailable
                ? t("agentList.archiveSheet.hostOffline")
                : t("agentList.archiveSheet.runningAgent")}
            </Text>
            <View style={styles.sheetButtonRow}>
              <Pressable
                style={SHEET_CANCEL_BUTTON_STYLE}
                onPress={handleCloseActionSheet}
                testID="agent-action-cancel"
              >
                <Text style={styles.sheetCancelText}>{t("common.actions.cancel")}</Text>
              </Pressable>
              <Pressable
                disabled={isActionDaemonUnavailable}
                style={SHEET_ARCHIVE_BUTTON_STYLE}
                onPress={handleArchiveAgent}
                testID="agent-action-archive"
              >
                <Text style={sheetArchiveTextStyle}>{t("agentList.archiveSheet.archive")}</Text>
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
  row: {
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
  disclosureButton: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  childIndent: {
    width: 28,
  },
}));

const SHEET_CANCEL_BUTTON_STYLE = [styles.sheetButton, styles.sheetCancelButton];
const SHEET_ARCHIVE_BUTTON_STYLE = [styles.sheetButton, styles.sheetArchiveButton];
