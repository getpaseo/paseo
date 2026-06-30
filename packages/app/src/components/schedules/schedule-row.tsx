import { MoreVertical, Pause, Pencil, Play, RotateCw, Trash2 } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
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
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { formatCadence, formatNextRun, resolveScheduleTitle } from "@/utils/schedule-format";
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
  isFirst: boolean;
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
function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={PROVIDER_ICON_SIZE} color={styles.providerIcon.color} />;
}

/**
 * One schedule, rendered as a settings-style card row: provider glyph + title,
 * a muted secondary line (model · cadence · next run), a StatusBadge, and the
 * kebab menu that owns every row action. Tapping the row opens the editor.
 *
 * Hover lives on the outer plain View (docs/hover.md): the inner Pressable owns
 * press, the nested kebab Pressable never fights it, and the row background
 * highlights without reflow.
 */
export function ScheduleRow({
  schedule,
  pending,
  isFirst,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const provider = resolveProvider(schedule);
  const title = resolveScheduleTitle(schedule);
  const meta = [
    resolveModelLabel(schedule),
    formatCadence(schedule.cadence),
    nextRunLabel(schedule),
  ]
    .filter(Boolean)
    .join("  ·  ");

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
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
        <View style={styles.main}>
          <View style={styles.leading}>
            <ProviderGlyph provider={provider} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>

        <View style={styles.trailing}>
          <StatusBadge
            label={statusLabel(schedule.status)}
            variant={statusVariant(schedule.status)}
          />
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
      </Pressable>
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
}: Omit<ScheduleRowProps, "isFirst">): ReactElement {
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

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the dynamic provider icon (compliant idiom).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  leading: {
    width: PROVIDER_ICON_SIZE,
    height: PROVIDER_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
