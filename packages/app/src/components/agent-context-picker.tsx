import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Bot, Check, History } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  buildAgentContextSourceGroups,
  getAgentContextAttachmentKey,
  getAgentContextSourceKey,
  getAgentContextSourceTitle,
  getAgentContextSourceWorkspaceLabel,
  isAgentContextAttachment,
  isAgentContextSourceSelectionDisabled,
  MAX_AGENT_CONTEXT_ATTACHMENTS,
  type AgentContextSourceGroupKind,
} from "@/components/agent-context-picker-view-model";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const AGENT_CONTEXT_PICKER_SNAP_POINTS = ["70%", "92%"];

const ThemedBot = withUnistyles(Bot);
const ThemedCheck = withUnistyles(Check);
const ThemedHistory = withUnistyles(History);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface AgentContextPickerProps {
  visible: boolean;
  serverId: string;
  workspaceId?: string | null;
  projectKey?: string | null;
  currentAgentId?: string | null;
  attachments: readonly UserComposerAttachment[];
  supported: boolean;
  onClose: () => void;
  onAdd: (source: AggregatedAgent) => void;
}

function groupLabel(
  group: AgentContextSourceGroupKind,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (group === "workspace") {
    return t("agentContext.groups.workspace");
  }
  if (group === "project") {
    return t("agentContext.groups.project");
  }
  return t("agentContext.groups.other");
}

function AgentProviderIcon({ source }: { source: AggregatedAgent }) {
  const ThemedProviderIcon = useMemo(
    () =>
      withUnistyles(source.provider ? getProviderIcon(source.provider) : Bot, (theme) => ({
        color: theme.colors.foregroundMuted,
      })),
    [source.provider],
  );
  return <ThemedProviderIcon size={ICON_SIZE.md} />;
}

function AgentContextSourceRow({
  source,
  selected,
  attached,
  disabled,
  onPress,
}: {
  source: AggregatedAgent;
  selected: boolean;
  attached: boolean;
  disabled: boolean;
  onPress: (source: AggregatedAgent) => void;
}) {
  const { t } = useTranslation();
  const title = getAgentContextSourceTitle(source);
  const workspace = getAgentContextSourceWorkspaceLabel(source);
  const meta = [source.provider, workspace].filter(Boolean).join(" · ");
  const notice = attached ? t("agentContext.status.attached") : null;
  const handlePress = useCallback(() => onPress(source), [onPress, source]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (hovered || selected) && styles.rowHovered,
      pressed && styles.rowPressed,
      disabled && styles.rowDisabled,
    ],
    [disabled, selected],
  );
  const selectionStyle = useMemo(
    () => [
      styles.selection,
      selected && styles.selectionSelected,
      attached && styles.selectionAttached,
    ],
    [attached, selected],
  );
  const accessibilityState = useMemo(
    () => ({ checked: selected || attached, disabled }),
    [attached, disabled, selected],
  );

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={[title, meta, notice].filter(Boolean).join(". ")}
      accessibilityState={accessibilityState}
      aria-checked={selected || attached}
      disabled={disabled}
      onPress={handlePress}
      style={pressableStyle}
      testID={`agent-context-source-${source.id}`}
    >
      <View style={selectionStyle}>
        {selected || attached ? (
          <ThemedCheck
            size={12}
            uniProps={attached ? foregroundColorMapping : accentColorMapping}
          />
        ) : null}
      </View>
      <View style={styles.iconSlot}>
        <AgentProviderIcon source={source} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowTime}>{formatTimeAgo(source.lastActivityAt)}</Text>
        </View>
        {meta ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        {notice ? <Text style={styles.rowNotice}>{notice}</Text> : null}
      </View>
    </Pressable>
  );
}

function AgentContextPickerStatus({
  supported,
  isConnected,
  isInitialLoad,
  isError,
  selectionLimitReached,
  isEmpty,
  hasQuery,
  onRetry,
}: {
  supported: boolean;
  isConnected: boolean;
  isInitialLoad: boolean;
  isError: boolean;
  selectionLimitReached: boolean;
  isEmpty: boolean;
  hasQuery: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!supported) {
    return <Text style={styles.statusText}>{t("agentContext.status.updateHost")}</Text>;
  }
  if (!isConnected) {
    return <Text style={styles.statusText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  }
  return (
    <>
      {isInitialLoad ? (
        <View style={styles.loadingRow} testID="agent-context-loading">
          <ThemedLoadingSpinner size={ICON_SIZE.md} uniProps={mutedColorMapping} />
          <Text style={styles.statusText}>{t("agentContext.status.loading")}</Text>
        </View>
      ) : null}
      {isError ? (
        <View style={styles.errorRow}>
          <Text style={styles.statusText}>{t("agentContext.status.failed")}</Text>
          <Button size="sm" variant="ghost" onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {selectionLimitReached ? (
        <Text style={styles.statusText}>
          {t("agentContext.status.limitReached", { count: MAX_AGENT_CONTEXT_ATTACHMENTS })}
        </Text>
      ) : null}
      {isEmpty && !isError ? (
        <View style={styles.emptyState} testID="agent-context-empty">
          <ThemedBot size={ICON_SIZE.lg} uniProps={mutedColorMapping} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>
            {hasQuery ? t("agentContext.status.noMatches") : t("agentContext.status.empty")}
          </Text>
        </View>
      ) : null}
    </>
  );
}

export function AgentContextPicker({
  visible,
  serverId,
  workspaceId,
  projectKey,
  currentAgentId,
  attachments,
  supported,
  onClose,
  onAdd,
}: AgentContextPickerProps) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<readonly AggregatedAgent[]>([]);
  const history = useAgentHistory({
    serverId,
    enabled: visible && supported && isConnected,
    search: query,
  });

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setSelection([]);
    }
  }, [visible]);

  const existingKeys = useMemo(
    () =>
      new Set(
        attachments
          .filter(isAgentContextAttachment)
          .map((attachment) => getAgentContextAttachmentKey(attachment)),
      ),
    [attachments],
  );
  const groups = useMemo(
    () =>
      buildAgentContextSourceGroups({
        agents: history.agents,
        serverId,
        workspaceId,
        projectKey,
        currentAgentId,
        // The daemon searches every retained source, including branch names and
        // fuzzy matches. Re-filtering its ranked response locally would drop
        // valid matches outside the initially loaded page.
        query: history.isSearchSupported ? "" : query,
      }),
    [
      currentAgentId,
      history.agents,
      history.isSearchSupported,
      projectKey,
      query,
      serverId,
      workspaceId,
    ],
  );
  const selectionKeys = useMemo(
    () => new Set(selection.map((source) => getAgentContextSourceKey(source))),
    [selection],
  );
  const existingCount = existingKeys.size;
  const remainingSlots = Math.max(0, MAX_AGENT_CONTEXT_ATTACHMENTS - existingCount);
  const selectionLimitReached =
    remainingSlots === 0 || (remainingSlots > 0 && selection.length >= remainingSlots);

  const handleToggle = useCallback(
    (source: AggregatedAgent) => {
      const key = getAgentContextSourceKey(source);
      if (existingKeys.has(key)) {
        return;
      }
      setSelection((current) => {
        if (current.some((entry) => getAgentContextSourceKey(entry) === key)) {
          return current.filter((entry) => getAgentContextSourceKey(entry) !== key);
        }
        if (current.length >= remainingSlots) {
          return current;
        }
        return [...current, source];
      });
    },
    [existingKeys, remainingSlots],
  );
  const handleAdd = useCallback(() => {
    for (const source of selection) {
      onAdd(source);
    }
    onClose();
  }, [onAdd, onClose, selection]);
  const { refreshAll } = history;
  const handleRetry = useCallback(() => {
    void refreshAll();
  }, [refreshAll]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("agentContext.title"),
      subtitle: <Text style={styles.headerSubtitle}>{t("agentContext.subtitle")}</Text>,
      search: {
        onChange: setQuery,
        placeholder: t("agentContext.searchPlaceholder"),
        resetKey: visible ? 0 : 1,
        testID: "agent-context-search",
      },
    }),
    [t, visible],
  );
  const isEmpty = isConnected && groups.length === 0 && !history.isInitialLoad;
  const isConfirmDisabled = selection.length === 0 || !supported;
  const footer = useMemo(
    () =>
      supported ? (
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            {t("agentContext.selectionCount", { count: selection.length })}
          </Text>
          <Button
            variant="default"
            size="xs"
            onPress={handleAdd}
            disabled={isConfirmDisabled}
            testID="agent-context-confirm"
          >
            {t("agentContext.actions.attach")}
          </Button>
        </View>
      ) : undefined,
    [handleAdd, isConfirmDisabled, selection.length, supported, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      testID="agent-context-picker"
      desktopMaxWidth={600}
      snapPoints={AGENT_CONTEXT_PICKER_SNAP_POINTS}
    >
      <AgentContextPickerStatus
        supported={supported}
        isConnected={isConnected}
        isInitialLoad={history.isInitialLoad}
        isError={history.isError}
        selectionLimitReached={selectionLimitReached}
        isEmpty={isEmpty}
        hasQuery={Boolean(query.trim())}
        onRetry={handleRetry}
      />
      {supported
        ? groups.map((group) => (
            <View key={group.kind} style={styles.group}>
              <Text style={styles.groupTitle}>{groupLabel(group.kind, t)}</Text>
              {group.agents.map((source) => {
                const key = getAgentContextSourceKey(source);
                const attached = existingKeys.has(key);
                const selected = selectionKeys.has(key);
                return (
                  <AgentContextSourceRow
                    key={key}
                    source={source}
                    selected={selected}
                    attached={attached}
                    disabled={isAgentContextSourceSelectionDisabled({
                      attached,
                      selected,
                      selectionCount: selection.length,
                      remainingSlots,
                    })}
                    onPress={handleToggle}
                  />
                );
              })}
            </View>
          ))
        : null}
      {supported && history.hasMore ? (
        <View style={styles.loadMore}>
          <Button
            size="sm"
            variant="ghost"
            onPress={history.loadMore}
            loading={history.isLoadingMore}
            disabled={history.isLoadingMore}
          >
            {t("agentContext.actions.loadMore")}
          </Button>
        </View>
      ) : null}
      <View style={styles.sourceNote}>
        <ThemedHistory size={14} uniProps={mutedColorMapping} />
        <Text style={styles.sourceNoteText}>{t("agentContext.sameHostNote")}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  headerSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
  },
  errorRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[8],
  },
  emptyTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  group: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[6],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[1],
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    gap: theme.spacing[2],
    minHeight: 56,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowDisabled: {
    opacity: 0.6,
  },
  selection: {
    alignItems: "center",
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    height: 18,
    justifyContent: "center",
    width: 18,
  },
  selectionSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  selectionAttached: {
    backgroundColor: theme.colors.surface3,
  },
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
    width: 22,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
  rowTitleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  rowTitle: {
    color: theme.colors.foreground,
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  rowTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  rowNotice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  footer: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[4],
    justifyContent: "space-between",
    minWidth: 0,
  },
  footerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loadMore: {
    alignItems: "center",
    paddingVertical: theme.spacing[3],
  },
  sourceNote: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  sourceNoteText: {
    color: theme.colors.foregroundMuted,
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
}));
