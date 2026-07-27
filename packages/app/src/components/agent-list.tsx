import {
  View,
  Text,
  Pressable,
  RefreshControl,
  FlatList,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { useCallback, useMemo, type ReactElement } from "react";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTimeAgo } from "@/utils/time";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { Archive, Check, ChevronRight } from "lucide-react-native";
import { getProviderIcon } from "@/components/provider-icons";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { isArchivedAgentSelectable, toAgentListKey } from "@/components/agent-list-selection";

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
  selectionMode?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onToggleSelect?: (agent: AggregatedAgent) => void;
}

type DateSectionKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

const DATE_SECTION_ORDER = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
] as const satisfies readonly DateSectionKey[];

const EMPTY_SELECTED_KEYS: ReadonlySet<string> = new Set();

type FlatListItem =
  | { type: "header"; key: string; section: DateSectionKey }
  | { type: "agent"; key: string; agent: AggregatedAgent };

function deriveDateSectionKey(lastActivityAt: Date): DateSectionKey {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const activityStart = new Date(
    lastActivityAt.getFullYear(),
    lastActivityAt.getMonth(),
    lastActivityAt.getDate(),
  );

  if (activityStart.getTime() >= todayStart.getTime()) {
    return "today";
  }
  if (activityStart.getTime() >= yesterdayStart.getTime()) {
    return "yesterday";
  }

  const diffTime = todayStart.getTime() - activityStart.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) {
    return "thisWeek";
  }
  if (diffDays <= 30) {
    return "thisMonth";
  }
  return "older";
}

function formatDateSectionLabel(t: TFunction, section: DateSectionKey): string {
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

function SelectionCheck({ checked, disabled }: { checked: boolean; disabled: boolean }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        styles.selectionCheck,
        checked && styles.selectionCheckChecked,
        disabled && styles.selectionCheckDisabled,
      ]}
    >
      {checked ? <Check size={12} color={theme.colors.primaryForeground} /> : null}
    </View>
  );
}

function SessionRow({
  agent,
  isMobile,
  selectedAgentId,
  showAttentionIndicator,
  showHostColumn,
  selectionMode,
  isChecked,
  onPress,
}: {
  agent: AggregatedAgent;
  isMobile: boolean;
  selectedAgentId?: string;
  showAttentionIndicator: boolean;
  showHostColumn: boolean;
  selectionMode: boolean;
  isChecked: boolean;
  onPress: (agent: AggregatedAgent) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const timeAgo = formatTimeAgo(agent.lastActivityAt);
  const agentKey = toAgentListKey(agent);
  const isRouteSelected = selectedAgentId === agentKey;
  const isSelectable = isArchivedAgentSelectable(agent);
  const projectName = agent.projectPlacement?.projectName ?? "";
  const branch = agent.projectPlacement?.checkout.currentBranch ?? "";
  const workspaceName = agent.projectPlacement?.workspaceName ?? "";
  const ProviderIcon = getProviderIcon(agent.provider);
  const pendingPermissionCount = agent.pendingPermissionCount ?? 0;

  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      isRouteSelected && !selectionMode && styles.rowSelected,
      isChecked && selectionMode && styles.rowSelected,
      selectionMode && !isSelectable && styles.rowSelectionDisabled,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isChecked, isRouteSelected, isSelectable, selectionMode],
  );

  const handlePress = useCallback(() => onPress(agent), [onPress, agent]);

  const sessionTitleStyle = useMemo(
    () => [
      styles.sessionTitle,
      isRouteSelected && !selectionMode && styles.sessionTitleHighlighted,
    ],
    [isRouteSelected, selectionMode],
  );

  const archivedIcon = useMemo(
    () => <Archive size={theme.fontSize.xs} color={theme.colors.foregroundMuted} />,
    [theme.fontSize.xs, theme.colors.foregroundMuted],
  );
  const showDesktopAttention =
    !isMobile && showAttentionIndicator && Boolean(agent.requiresAttention);

  const accessibilityState = useMemo(() => {
    if (!selectionMode) {
      return undefined;
    }
    return { checked: isChecked, disabled: !isSelectable };
  }, [isChecked, isSelectable, selectionMode]);

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={selectionMode && !isSelectable}
      testID={`agent-row-${agent.serverId}-${agent.id}`}
      accessibilityState={accessibilityState}
    >
      {selectionMode ? <SelectionCheck checked={isChecked} disabled={!isSelectable} /> : null}
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
  selectionMode = false,
  selectedKeys,
  onToggleSelect,
}: AgentListProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const resolvedSelectedKeys = selectedKeys ?? EMPTY_SELECTED_KEYS;

  const handleAgentPress = useCallback(
    (agent: AggregatedAgent) => {
      if (selectionMode) {
        if (!isArchivedAgentSelectable(agent)) {
          return;
        }
        onToggleSelect?.(agent);
        return;
      }

      onAgentSelect?.();
      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        pin: true,
      });
    },
    [onAgentSelect, onToggleSelect, selectionMode],
  );

  const flatItems = useMemo((): FlatListItem[] => {
    const buckets = new Map<DateSectionKey, AggregatedAgent[]>();
    for (const agent of agents) {
      const section = deriveDateSectionKey(agent.lastActivityAt);
      const existing = buckets.get(section) ?? [];
      existing.push(agent);
      buckets.set(section, existing);
    }

    const result: FlatListItem[] = [];
    for (const section of DATE_SECTION_ORDER) {
      const data = buckets.get(section);
      if (!data || data.length === 0) {
        continue;
      }
      result.push({ type: "header", key: `header:${section}`, section });
      for (const agent of data) {
        result.push({ type: "agent", key: toAgentListKey(agent), agent });
      }
    }
    return result;
  }, [agents]);

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
          selectionMode={selectionMode}
          isChecked={resolvedSelectedKeys.has(item.key)}
          onPress={handleAgentPress}
        />
      );
    },
    [
      handleAgentPress,
      isMobile,
      resolvedSelectedKeys,
      selectedAgentId,
      selectionMode,
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
  rowSelectionDisabled: {
    opacity: 0.45,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  selectionCheck: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[2],
    flexShrink: 0,
  },
  selectionCheckChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  selectionCheckDisabled: {
    opacity: 0.4,
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
}));
