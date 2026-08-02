import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { normalizeBackgroundTaskDisplayType, type BackgroundTaskDisplayType } from "./type-badge";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSquare = withUnistyles(Square);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface BackgroundTasksTrackProps {
  rows: BackgroundTaskDescriptorPayload[];
  onOpenTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  stoppingTaskIds?: ReadonlySet<string>;
}

const LIST_MAX_HEIGHT = 200;

function rowLabel(row: BackgroundTaskDescriptorPayload): string {
  const command = row.command?.trim();
  if (command) return command;
  const description = row.description.trim();
  return description.length > 0 ? description : row.taskId;
}

function statusLabel(
  status: BackgroundTaskDescriptorPayload["status"],
  t: (key: string) => string,
): string {
  switch (status) {
    case "running":
      return t("backgroundTasks.statusRunning");
    case "stopped":
      return t("backgroundTasks.statusStopped");
    case "failed":
      return t("backgroundTasks.statusFailed");
    case "completed":
      return t("backgroundTasks.statusCompleted");
    default:
      return t("backgroundTasks.statusUnknown");
  }
}

function typeBadgeLabel(
  displayType: BackgroundTaskDisplayType,
  t: (key: string) => string,
): string {
  switch (displayType) {
    case "shell":
      return t("backgroundTasks.typeShell");
    case "monitor":
      return t("backgroundTasks.typeMonitor");
    case "workflow":
      return t("backgroundTasks.typeWorkflow");
    case "other":
      return t("backgroundTasks.typeOther");
  }
}

export function BackgroundTasksTrack({
  rows,
  onOpenTask,
  onStopTask,
  stoppingTaskIds,
}: BackgroundTasksTrackProps): ReactElement | null {
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
    rows.length > 0
      ? t("backgroundTasks.headerCount", { count: rows.length })
      : t("backgroundTasks.header");

  return (
    <View style={styles.outer} testID="background-tasks-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="background-tasks-track-header"
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
                <BackgroundTasksTrackRow
                  key={row.taskId}
                  row={row}
                  stopping={stoppingTaskIds?.has(row.taskId) === true}
                  onOpenTask={onOpenTask}
                  onStopTask={onStopTask}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function BackgroundTasksTrackRow({
  row,
  stopping,
  onOpenTask,
  onStopTask,
}: {
  row: BackgroundTaskDescriptorPayload;
  stopping: boolean;
  onOpenTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const label = rowLabel(row);
  const displayType = normalizeBackgroundTaskDisplayType(row.type);
  const typeLabel = typeBadgeLabel(displayType, t);
  const handlePress = useCallback(() => {
    onOpenTask(row.taskId);
  }, [onOpenTask, row.taskId]);
  const handleStopPress = useCallback(() => {
    onStopTask(row.taskId);
  }, [onStopTask, row.taskId]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;
  const canStop = row.status === "running" || row.status === "unknown";

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${typeLabel} ${label}`}
        testID={`background-tasks-track-row-${row.taskId}`}
        onPress={handlePress}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <View style={styles.rowText}>
              <View style={styles.rowTitle}>
                <StatusBadge label={typeLabel} variant="muted" />
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {label}
                </Text>
              </View>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {statusLabel(row.status, t)}
              </Text>
            </View>
            {canStop ? (
              <BackgroundTaskStopButton
                label={label}
                taskId={row.taskId}
                visible={actionsVisible}
                stopping={stopping}
                onPress={handleStopPress}
              />
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function BackgroundTaskStopButton({
  label,
  taskId,
  visible,
  stopping,
  onPress,
}: {
  label: string;
  taskId: string;
  visible: boolean;
  stopping: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible || stopping}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("backgroundTasks.stopAction", { label })}
            testID={`background-tasks-track-stop-${taskId}`}
            onPress={onPress}
            style={styles.actionButton}
            hitSlop={8}
            disabled={stopping}
          >
            {({ hovered: actionHovered, pressed: actionPressed }) => (
              <ThemedSquare
                size={14}
                uniProps={
                  actionHovered || actionPressed
                    ? foregroundColorMapping
                    : foregroundMutedColorMapping
                }
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("backgroundTasks.stopTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
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
  rowTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
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
