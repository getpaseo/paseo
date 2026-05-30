import { MoreVertical, Pause, Pencil, Play, RotateCw, Trash2 } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { getProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { formatCadence, formatNextRun } from "@/utils/schedule-format";
import { shortenPath } from "@/utils/shorten-path";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

// Themed lucide wrappers — module-scope so only the icon re-renders on theme
// change (never call useUnistyles in render). See docs/unistyles.md.
const ThemedPencil = withUnistyles(Pencil);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const ACTION_ICON_SIZE = 15;
const MENU_ICON_SIZE = 14;
const PROVIDER_ICON_SIZE = 16;

// Pending flags for each action so the parent table can wire a mutation hook
// and the row reflects in-flight state without owning the mutation itself.
export interface ScheduleRowPending {
  pause?: boolean;
  resume?: boolean;
  runNow?: boolean;
  delete?: boolean;
}

export interface ScheduleRowActions {
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

interface ScheduleRowProps extends ScheduleRowActions {
  schedule: ScheduleSummary;
  pending?: ScheduleRowPending;
}

/** Row primary label: name → title → first prompt line → fallback. */
function resolveTitle(schedule: ScheduleSummary): string {
  const name = schedule.name?.trim();
  if (name) {
    return name;
  }
  if (schedule.target.type === "new-agent") {
    const configTitle = schedule.target.config.title?.trim();
    if (configTitle) {
      return configTitle;
    }
  }
  const firstPromptLine = schedule.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstPromptLine || "Untitled schedule";
}

function resolveProvider(schedule: ScheduleSummary): string | null {
  return schedule.target.type === "new-agent" ? schedule.target.config.provider : null;
}

function resolveModelLabel(schedule: ScheduleSummary): string {
  if (schedule.target.type === "new-agent" && schedule.target.config.model) {
    return schedule.target.config.model;
  }
  return "Default model";
}

function resolveCwd(schedule: ScheduleSummary): string | null {
  if (schedule.target.type !== "new-agent") {
    return null;
  }
  const cwd = schedule.target.config.cwd?.trim();
  return cwd ? shortenPath(cwd) : null;
}

function statusVariant(status: ScheduleSummary["status"]): "success" | "muted" {
  return status === "active" ? "success" : "muted";
}

function statusLabel(status: ScheduleSummary["status"]): string {
  if (status === "active") {
    return "Active";
  }
  if (status === "paused") {
    return "Paused";
  }
  return "Completed";
}

function nextRunLabel(schedule: ScheduleSummary): string {
  if (schedule.status === "paused") {
    return "Paused";
  }
  if (schedule.status === "completed") {
    return "Completed";
  }
  return formatNextRun(schedule.nextRunAt) || "—";
}

/** Small provider glyph. Reads the icon color off a StyleSheet object so the
 * dynamic component (getProviderIcon) stays compliant without useUnistyles. */
function ProviderGlyph({
  provider,
  size = PROVIDER_ICON_SIZE,
}: {
  provider: string | null;
  size?: number;
}): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={size} color={styles.providerIcon.color} />;
}

export function ScheduleRow(props: ScheduleRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  if (isCompact || isNative) {
    return <CompactScheduleRow {...props} />;
  }
  return <DesktopScheduleRow {...props} />;
}

// ---------------------------------------------------------------------------
// Desktop — borderless SaaS table row with hover-revealed action cluster
// ---------------------------------------------------------------------------

function DesktopScheduleRow({
  schedule,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const provider = resolveProvider(schedule);
  const title = resolveTitle(schedule);
  const cwd = resolveCwd(schedule);
  const model = resolveModelLabel(schedule);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.desktopRow,
      isHovered && styles.desktopRowHovered,
      pressed && styles.desktopRowPressed,
    ],
    [isHovered],
  );

  // Actions are always mounted; revealed via opacity + pointerEvents so the row
  // never reflows on hover (docs/hover.md). Always shown on native/compact —
  // but this branch is desktop-only, so isHovered drives it.
  const actionsStyle = useMemo(
    () => [styles.actionCluster, !isHovered && styles.actionClusterHidden],
    [isHovered],
  );

  return (
    <View
      style={styles.desktopRowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={`Edit schedule ${title}`}
        testID={`schedule-row-${schedule.id}`}
      >
        <View style={styles.colName}>
          <ProviderGlyph provider={provider} />
          <View style={styles.nameTextGroup}>
            <Text style={styles.titleText} numberOfLines={1}>
              {title}
            </Text>
            {cwd ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {cwd}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.colModel}>
          <ProviderGlyph provider={provider} size={MENU_ICON_SIZE} />
          <Text style={styles.cellText} numberOfLines={1}>
            {model}
          </Text>
        </View>

        <View style={styles.colCadence}>
          <Text style={styles.cellText} numberOfLines={1}>
            {formatCadence(schedule.cadence)}
          </Text>
        </View>

        <View style={styles.colNextRun}>
          <Text style={styles.cellText} numberOfLines={1}>
            {nextRunLabel(schedule)}
          </Text>
        </View>

        <View style={styles.colStatus}>
          <StatusBadge
            label={statusLabel(schedule.status)}
            variant={statusVariant(schedule.status)}
          />
        </View>

        <View style={styles.colActions} pointerEvents="box-none">
          <View style={actionsStyle} pointerEvents={isHovered ? "auto" : "none"}>
            <ActionIconButton
              variant="edit"
              label="Edit schedule"
              onPress={onEdit}
              testID={`schedule-action-edit-${schedule.id}`}
            />
            {schedule.status === "paused" ? (
              <ActionIconButton
                variant="resume"
                label="Resume schedule"
                busy={pending?.resume}
                onPress={onResume}
                testID={`schedule-action-resume-${schedule.id}`}
              />
            ) : (
              <ActionIconButton
                variant="pause"
                label="Pause schedule"
                busy={pending?.pause}
                disabled={schedule.status === "completed"}
                onPress={onPause}
                testID={`schedule-action-pause-${schedule.id}`}
              />
            )}
            <ActionIconButton
              variant="run"
              label="Run now"
              busy={pending?.runNow}
              onPress={onRunNow}
              testID={`schedule-action-run-${schedule.id}`}
            />
            <ActionIconButton
              variant="delete"
              label="Delete schedule"
              busy={pending?.delete}
              destructive
              onPress={onDelete}
              testID={`schedule-action-delete-${schedule.id}`}
            />
          </View>
        </View>
      </Pressable>
    </View>
  );
}

type ActionVariant = "edit" | "pause" | "resume" | "run" | "delete";

// Module-scope icon elements keep JSX out of the render-time prop path
// (eslint-plugin-react-perf) and avoid re-creating elements per row.
const ACTION_ICONS: Record<ActionVariant, ReactNode> = {
  edit: <ThemedPencil size={ACTION_ICON_SIZE} uniProps={mutedColorMapping} />,
  pause: <ThemedPause size={ACTION_ICON_SIZE} uniProps={mutedColorMapping} />,
  resume: <ThemedPlay size={ACTION_ICON_SIZE} uniProps={mutedColorMapping} />,
  run: <ThemedRotateCw size={ACTION_ICON_SIZE} uniProps={mutedColorMapping} />,
  delete: <ThemedTrash2 size={ACTION_ICON_SIZE} uniProps={destructiveColorMapping} />,
};

function ActionIconButton({
  variant,
  label,
  onPress,
  busy,
  disabled,
  destructive,
  testID,
}: {
  variant: ActionVariant;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
}): ReactElement {
  const isDisabled = Boolean(disabled || busy);
  const buttonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.iconButton,
      hovered && (destructive ? styles.iconButtonHoveredDestructive : styles.iconButtonHovered),
      pressed && styles.iconButtonPressed,
      isDisabled && styles.iconButtonDisabled,
    ],
    [destructive, isDisabled],
  );
  // The button sits inside the row Pressable (which opens edit on press); stop
  // the event so acting on a row never also opens the editor (web bubbling).
  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  return (
    <Pressable
      style={buttonStyle}
      onPress={handlePress}
      onPressIn={handlePressIn}
      disabled={isDisabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      {ACTION_ICONS[variant]}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Compact — stacked row with an always-visible kebab menu
// ---------------------------------------------------------------------------

function CompactScheduleRow({
  schedule,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const provider = resolveProvider(schedule);
  const title = resolveTitle(schedule);
  const model = resolveModelLabel(schedule);

  const metaParts = [model, formatCadence(schedule.cadence), nextRunLabel(schedule)].filter(
    Boolean,
  );

  return (
    <View style={styles.compactRow}>
      <View style={styles.compactBody}>
        <View style={styles.compactTitleRow}>
          <ProviderGlyph provider={provider} size={MENU_ICON_SIZE} />
          <Text style={styles.titleText} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.compactStatus}>
            <StatusBadge
              label={statusLabel(schedule.status)}
              variant={statusVariant(schedule.status)}
            />
          </View>
        </View>
        <Text style={styles.metaText} numberOfLines={1}>
          {metaParts.join("  ·  ")}
        </Text>
      </View>
      <ScheduleKebabMenu
        schedule={schedule}
        pending={pending}
        onEdit={onEdit}
        onPause={onPause}
        onResume={onResume}
        onRunNow={onRunNow}
        onDelete={onDelete}
      />
    </View>
  );
}

const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const pauseLeading = <ThemedPause size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const resumeLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const runLeading = <ThemedRotateCw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function ScheduleKebabMenu({
  schedule,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel="Schedule actions"
        testID={`schedule-kebab-${schedule.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={editLeading}
          onSelect={onEdit}
          testID={`schedule-menu-edit-${schedule.id}`}
        >
          Edit schedule
        </DropdownMenuItem>
        {schedule.status === "paused" ? (
          <DropdownMenuItem
            leading={resumeLeading}
            status={pending?.resume ? "pending" : "idle"}
            pendingLabel="Resuming..."
            onSelect={onResume}
            testID={`schedule-menu-resume-${schedule.id}`}
          >
            Resume schedule
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            leading={pauseLeading}
            disabled={schedule.status === "completed"}
            status={pending?.pause ? "pending" : "idle"}
            pendingLabel="Pausing..."
            onSelect={onPause}
            testID={`schedule-menu-pause-${schedule.id}`}
          >
            Pause schedule
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          leading={runLeading}
          status={pending?.runNow ? "pending" : "idle"}
          pendingLabel="Starting..."
          onSelect={onRunNow}
          testID={`schedule-menu-run-${schedule.id}`}
        >
          Run now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel="Deleting..."
          onSelect={onDelete}
          testID={`schedule-menu-delete-${schedule.id}`}
        >
          Delete schedule
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

// ---------------------------------------------------------------------------
// Desktop column header
// ---------------------------------------------------------------------------

export function SchedulesColumnHeader(): ReactElement {
  return (
    <View style={styles.headerRow}>
      <Text style={headerNameStyle}>Name</Text>
      <Text style={headerModelStyle}>Model</Text>
      <Text style={headerCadenceStyle}>Cadence</Text>
      <Text style={headerNextRunStyle}>Next run</Text>
      <Text style={headerStatusStyle}>Status</Text>
      <View style={styles.colActions} />
    </View>
  );
}

const ROW_MIN_HEIGHT = 56;
const ACTIONS_COLUMN_WIDTH = 148;

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the dynamic provider icon (compliant idiom).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },

  // --- shared columns (header + desktop row use the same flex weights) ---
  colName: {
    flex: 2.4,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  colModel: {
    flex: 1.6,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  colCadence: {
    flex: 1.4,
    minWidth: 0,
  },
  colNextRun: {
    flex: 1,
    minWidth: 0,
  },
  colStatus: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  colActions: {
    width: ACTIONS_COLUMN_WIDTH,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },

  nameTextGroup: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },

  // --- header ---
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  headerLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },

  // --- desktop row ---
  desktopRowContainer: {
    position: "relative",
  },
  desktopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  desktopRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  desktopRowPressed: {
    backgroundColor: theme.colors.surface2,
  },

  titleText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  cellText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  metaText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },

  // --- desktop action cluster ---
  actionCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  actionClusterHidden: {
    opacity: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonHoveredDestructive: {
    backgroundColor: theme.colors.palette.red[900],
  },
  iconButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
  iconButtonDisabled: {
    opacity: theme.opacity[50],
  },

  // --- compact row ---
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  compactBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  compactTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  compactStatus: {
    marginLeft: "auto",
  },

  // --- kebab ---
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));

// Precomputed column + label style arrays for the header row — hoisted so the
// JSX does not create a new array prop per render (eslint-plugin-react-perf).
const headerNameStyle = [styles.colName, styles.headerLabel];
const headerModelStyle = [styles.colModel, styles.headerLabel];
const headerCadenceStyle = [styles.colCadence, styles.headerLabel];
const headerNextRunStyle = [styles.colNextRun, styles.headerLabel];
const headerStatusStyle = [styles.colStatus, styles.headerLabel];
