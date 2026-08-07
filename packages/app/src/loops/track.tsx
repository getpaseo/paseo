import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import type { LoopRole, LoopTrackRow } from "./select";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSquare = withUnistyles(Square);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface LoopsTrackProps {
  rows: LoopTrackRow[];
  onOpenLoop: (loopId: string) => void;
  onStopLoop: (loopId: string) => void;
  stoppingLoopIds?: ReadonlySet<string>;
}

const LIST_MAX_HEIGHT = 200;

function rowLabel(row: LoopTrackRow): string {
  const name = row.name?.trim();
  if (name) return name;
  const preview = row.promptPreview?.trim();
  if (preview) return preview;
  return row.loopId;
}

function roleLabel(role: LoopRole, t: (key: string) => string): string {
  return role === "worker" ? t("loops.roleWorker") : t("loops.roleVerifier");
}

function statusLabel(status: LoopTrackRow["status"], t: (key: string) => string): string {
  switch (status) {
    case "running":
      return t("loops.statusRunning");
    default:
      return t("loops.statusUnknown");
  }
}

export function LoopsTrack({
  rows,
  onOpenLoop,
  onStopLoop,
  stoppingLoopIds,
}: LoopsTrackProps): ReactElement | null {
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

  const runningCount = rows.reduce(
    (count, row) => (row.status === "running" ? count + 1 : count),
    0,
  );
  let headerLabel = t("loops.headerCount", { count: rows.length });
  if (rows.length === 0) {
    headerLabel = t("loops.header");
  } else if (runningCount > 0) {
    headerLabel = t("loops.headerCountRunning", {
      count: rows.length,
      running: runningCount,
    });
  }

  return (
    <View style={styles.outer} testID="loops-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="loops-track-header"
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
                <LoopsTrackRow
                  key={`${row.loopId}:${row.role}`}
                  row={row}
                  stopping={stoppingLoopIds?.has(row.loopId) === true}
                  onOpenLoop={onOpenLoop}
                  onStopLoop={onStopLoop}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function LoopsTrackRow({
  row,
  stopping,
  onOpenLoop,
  onStopLoop,
}: {
  row: LoopTrackRow;
  stopping: boolean;
  onOpenLoop: (loopId: string) => void;
  onStopLoop: (loopId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const label = rowLabel(row);
  const role = roleLabel(row.role, t);
  const status = statusLabel(row.status, t);
  const iteration =
    row.activeIteration != null ? t("loops.iteration", { count: row.activeIteration }) : null;
  const a11yLabel = [role, label, status, iteration].filter(Boolean).join(" · ");
  const handlePress = useCallback(() => {
    onOpenLoop(row.loopId);
  }, [onOpenLoop, row.loopId]);
  const handleStopPress = useCallback(() => {
    onStopLoop(row.loopId);
  }, [onStopLoop, row.loopId]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;
  const canStop = row.status === "running";

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        testID={`loops-track-row-${row.loopId}`}
        onPress={handlePress}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <StatusBadge label={role} variant="muted" />
            <Text style={styles.rowLabel} numberOfLines={1}>
              {label}
            </Text>
            {iteration ? (
              <Text style={styles.rowInlineMeta} numberOfLines={1}>
                {iteration}
              </Text>
            ) : null}
            {canStop ? (
              <LoopStopButton
                label={label}
                loopId={row.loopId}
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

function LoopStopButton({
  label,
  loopId,
  visible,
  stopping,
  onPress,
}: {
  label: string;
  loopId: string;
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
            accessibilityLabel={t("loops.stopAction", { label })}
            testID={`loops-track-stop-${loopId}`}
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
          <Text style={styles.tooltipText}>{t("loops.stopTooltip")}</Text>
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
  rowLabel: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowInlineMeta: {
    flexShrink: 0,
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
