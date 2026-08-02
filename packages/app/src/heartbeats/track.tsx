import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { CalendarClock, ChevronDown, ChevronRight, Pause, Play, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { formatNextRun } from "@/utils/schedule-format";
import type { HeartbeatRow } from "./select";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCalendarClock = withUnistyles(CalendarClock);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedTrash2 = withUnistyles(Trash2);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

export interface HeartbeatsTrackProps {
  rows: HeartbeatRow[];
  onOpenRow: (row: HeartbeatRow) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (row: HeartbeatRow) => void;
  pendingIds?: ReadonlySet<string>;
}

const LIST_MAX_HEIGHT = 200;

function rowPrimaryLabel(row: HeartbeatRow): string {
  if (row.kind === "paseo") {
    const name = row.name?.trim();
    if (name) return name;
    const prompt = row.prompt.trim();
    if (prompt) return prompt;
    return row.id;
  }
  const prompt = row.prompt.trim();
  if (prompt) return prompt;
  return row.id;
}

function rowSecondaryLabel(
  row: HeartbeatRow,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (row.kind === "paseo") {
    if (row.status === "paused") {
      return `${row.cadenceLabel} · ${t("heartbeats.statusPaused")}`;
    }
    const next = formatNextRun(row.nextRunAt);
    if (next) {
      return `${row.cadenceLabel} · ${t("heartbeats.nextRun", { when: next })}`;
    }
    return row.cadenceLabel;
  }
  if (row.nextHint?.trim()) {
    return `${row.scheduleLabel} · ${row.nextHint}`;
  }
  return row.scheduleLabel;
}

export function HeartbeatsTrack({
  rows,
  onOpenRow,
  onPause,
  onResume,
  onDelete,
  pendingIds,
}: HeartbeatsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );
  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );
  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  if (rows.length === 0) {
    return null;
  }

  const headerLabel =
    rows.length > 0 ? t("heartbeats.headerCount", { count: rows.length }) : t("heartbeats.header");

  return (
    <View style={styles.outer} testID="heartbeats-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="heartbeats-track-header"
              onPress={toggleExpanded}
              style={headerStyle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {rows.map((row) => (
                <HeartbeatsTrackRow
                  key={`${row.kind}:${row.id}`}
                  row={row}
                  pending={pendingIds?.has(row.id) === true}
                  onOpenRow={onOpenRow}
                  onPause={onPause}
                  onResume={onResume}
                  onDelete={onDelete}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function HeartbeatsTrackRow({
  row,
  pending,
  onOpenRow,
  onPause,
  onResume,
  onDelete,
}: {
  row: HeartbeatRow;
  pending: boolean;
  onOpenRow: (row: HeartbeatRow) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (row: HeartbeatRow) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const label = rowPrimaryLabel(row);
  const meta = rowSecondaryLabel(row, t);
  const handlePress = useCallback(() => {
    onOpenRow(row);
  }, [onOpenRow, row]);
  const handlePausePress = useCallback(() => {
    onPause(row.id);
  }, [onPause, row.id]);
  const handleResumePress = useCallback(() => {
    onResume(row.id);
  }, [onResume, row.id]);
  const handleDeletePress = useCallback(() => {
    onDelete(row);
  }, [onDelete, row]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={`heartbeats-track-row-${row.kind}-${row.id}`}
        onPress={handlePress}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <HeartbeatLeadingIcon row={row} />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {label}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {meta}
              </Text>
            </View>
            <HeartbeatRowActions
              row={row}
              label={label}
              visible={actionsVisible}
              pending={pending}
              onPausePress={handlePausePress}
              onResumePress={handleResumePress}
              onDeletePress={handleDeletePress}
            />
          </View>
        )}
      </Pressable>
    </View>
  );
}

function HeartbeatLeadingIcon({ row }: { row: HeartbeatRow }): ReactElement {
  if (row.kind === "provider") {
    const Icon = getProviderIcon(row.provider);
    return <Icon size={16} color={styles.providerIcon.color} />;
  }
  return <ThemedCalendarClock size={16} uniProps={foregroundMutedColorMapping} />;
}

function HeartbeatRowActions({
  row,
  label,
  visible,
  pending,
  onPausePress,
  onResumePress,
  onDeletePress,
}: {
  row: HeartbeatRow;
  label: string;
  visible: boolean;
  pending: boolean;
  onPausePress: () => void;
  onResumePress: () => void;
  onDeletePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {row.kind === "paseo" && row.status === "paused" ? (
        <HeartbeatActionButton
          accessibilityLabel={t("heartbeats.resumeAction", { label })}
          testID={`heartbeats-track-resume-${row.id}`}
          tooltipLabel={t("heartbeats.resumeTooltip")}
          icon="play"
          visible={visible}
          disabled={pending}
          onPress={onResumePress}
        />
      ) : null}
      {row.kind === "paseo" && row.status === "active" ? (
        <HeartbeatActionButton
          accessibilityLabel={t("heartbeats.pauseAction", { label })}
          testID={`heartbeats-track-pause-${row.id}`}
          tooltipLabel={t("heartbeats.pauseTooltip")}
          icon="pause"
          visible={visible}
          disabled={pending}
          onPress={onPausePress}
        />
      ) : null}
      <HeartbeatActionButton
        accessibilityLabel={t("heartbeats.deleteAction", { label })}
        testID={`heartbeats-track-delete-${row.kind}-${row.id}`}
        tooltipLabel={t("heartbeats.deleteTooltip")}
        icon="delete"
        visible={visible}
        disabled={pending}
        onPress={onDeletePress}
      />
    </View>
  );
}

function HeartbeatActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  disabled,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: "pause" | "play" | "delete";
  visible: boolean;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible || disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
          disabled={disabled}
        >
          {({ hovered: actionHovered, pressed: actionPressed }) => {
            const active = actionHovered || actionPressed;
            if (icon === "delete") {
              return (
                <ThemedTrash2
                  size={14}
                  uniProps={active ? destructiveColorMapping : foregroundMutedColorMapping}
                />
              );
            }
            if (icon === "play") {
              return (
                <ThemedPlay
                  size={14}
                  uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              );
            }
            return (
              <ThemedPause
                size={14}
                uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            );
          }}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
