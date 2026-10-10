import { MoreVertical, Pause, Pencil, Play, RotateCw, Trash2 } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { ScheduleDerivedState } from "@/schedules/schedule-derivation";
import {
  formatCadence,
  formatNextRun,
  resolveScheduleTitle,
  scheduleKind,
} from "@/utils/schedule-format";
import { useTimeAgo } from "@/hooks/use-time-ago";
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
  serverId: string;
  schedule: ScheduleSummary;
  /** Client-derived target line (agent title / project / shortened path). */
  targetLabel: string;
  /** Provider glyph, resolved from the schedule config or the target agent. */
  provider: string | null;
  /** Client-derived state — the single source for the badge and next-run copy. */
  state: ScheduleDerivedState;
  /** Host name, rendered when the list spans more than one host. */
  serverName?: string;
  /** True when only one host exists and the host name would be redundant. */
  singleHost?: boolean;
  pending?: ScheduleRowPending;
  isFirst: boolean;
}

function stateBadge(
  state: ScheduleDerivedState,
  t: TFunction,
): {
  label: string;
  variant: "success" | "error" | "muted";
} {
  switch (state) {
    case "active":
      return { label: t("schedules.states.active"), variant: "success" };
    case "paused":
      return { label: t("schedules.states.paused"), variant: "muted" };
    case "expired":
      return { label: t("schedules.states.expired"), variant: "muted" };
    case "finished":
      return { label: t("schedules.states.finished"), variant: "muted" };
    case "targetGone":
      return { label: t("schedules.states.targetGone"), variant: "error" };
  }
}

// Meta reads left-to-right as identity → history → future: how often, when it
// was created, when it last ran, and (only while it can still run) when it runs
// next. Status lives on the badge, never repeated here.
function buildMeta(input: {
  schedule: ScheduleSummary;
  state: ScheduleDerivedState;
  createdAgo: string;
  lastRunAgo: string;
  serverName: string | undefined;
  singleHost: boolean;
  t: TFunction;
}): string {
  const { schedule, state, serverName, singleHost, t } = input;
  const parts = [
    formatCadence(schedule.cadence),
    t("schedules.meta.created", { ago: input.createdAgo }),
    schedule.lastRunAt
      ? t("schedules.meta.lastRun", { ago: input.lastRunAgo })
      : t("schedules.meta.neverRun"),
  ];
  if (state === "active") {
    const next = formatNextRun(schedule.nextRunAt);
    if (next) {
      parts.push(t("schedules.meta.nextRun", { next }));
    }
  }
  if (serverName && !singleHost) {
    parts.unshift(serverName);
  }
  return parts.join(" · ");
}

function ScheduleMeta({
  schedule,
  state,
  serverName,
  singleHost,
}: {
  schedule: ScheduleSummary;
  state: ScheduleDerivedState;
  serverName: string | undefined;
  singleHost: boolean;
}) {
  const { t } = useTranslation();
  const createdAgo = useTimeAgo(new Date(schedule.createdAt));
  const lastRunAgo = useTimeAgo(schedule.lastRunAt ? new Date(schedule.lastRunAt) : null);
  const meta = buildMeta({ schedule, state, createdAgo, lastRunAgo, serverName, singleHost, t });
  return (
    <Text style={settingsStyles.rowHint} numberOfLines={1}>
      {meta}
    </Text>
  );
}

/** Small provider glyph. Reads the icon color off a StyleSheet object so the
 * dynamic component (useProviderIcon) stays compliant without useUnistyles. */
function ProviderGlyph({
  provider,
  serverId,
}: {
  provider: string | null;
  serverId: string;
}): ReactElement | null {
  const Icon = useProviderIcon(provider ?? "", serverId);
  if (!provider) {
    return null;
  }
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
  serverId,
  schedule,
  targetLabel,
  provider,
  state,
  serverName,
  singleHost,
  pending,
  isFirst,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const title = resolveScheduleTitle(schedule);
  const kind = scheduleKind(schedule);
  const badge = stateBadge(state, t);
  const canRun = schedule.target.type === "new-agent" && (state === "active" || state === "paused");

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
        accessibilityLabel={t(`schedules.kinds.${kind}.editRow`, { title })}
        testID={`schedule-row-${schedule.id}`}
      >
        <View style={styles.main}>
          <View style={styles.leading}>
            <ProviderGlyph provider={provider} serverId={serverId} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.target} numberOfLines={1}>
              {targetLabel}
            </Text>
            <ScheduleMeta
              schedule={schedule}
              state={state}
              serverName={serverName}
              singleHost={singleHost ?? false}
            />
          </View>
        </View>

        <View style={styles.trailing}>
          <StatusBadge label={badge.label} variant={badge.variant} />
          <ScheduleKebabMenu
            schedule={schedule}
            canRun={canRun}
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

function ScheduleExecutionMenuItems({
  schedule,
  canRun,
  pending,
  onPause,
  onResume,
  onRunNow,
}: Pick<ScheduleRowProps, "schedule" | "pending" | "onPause" | "onResume" | "onRunNow"> & {
  canRun: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (schedule.target.type === "agent") {
    return null;
  }

  let cadenceAction: ReactElement;
  if (schedule.status === "paused") {
    cadenceAction = (
      <DropdownMenuItem
        leading={resumeLeading}
        disabled={!canRun}
        status={pending?.resume ? "pending" : "idle"}
        pendingLabel={t("schedules.menu.resuming")}
        onSelect={onResume}
        testID={`schedule-menu-resume-${schedule.id}`}
      >
        {t("schedules.menu.resume")}
      </DropdownMenuItem>
    );
  } else {
    cadenceAction = (
      <DropdownMenuItem
        leading={pauseLeading}
        disabled={schedule.status === "completed" || !canRun}
        status={pending?.pause ? "pending" : "idle"}
        pendingLabel={t("schedules.menu.pausing")}
        onSelect={onPause}
        testID={`schedule-menu-pause-${schedule.id}`}
      >
        {t("schedules.menu.pause")}
      </DropdownMenuItem>
    );
  }

  return (
    <>
      {cadenceAction}
      <DropdownMenuItem
        leading={runLeading}
        disabled={!canRun}
        status={pending?.runNow ? "pending" : "idle"}
        pendingLabel={t("schedules.menu.starting")}
        onSelect={onRunNow}
        testID={`schedule-menu-run-${schedule.id}`}
      >
        {t("schedules.menu.runNow")}
      </DropdownMenuItem>
    </>
  );
}

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
  canRun,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: Pick<
  ScheduleRowProps,
  "schedule" | "pending" | "onEdit" | "onPause" | "onResume" | "onRunNow" | "onDelete"
> & {
  canRun: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const kind = scheduleKind(schedule);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t(`schedules.kinds.${kind}.actions`)}
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
          {t(`schedules.kinds.${kind}.edit`)}
        </DropdownMenuItem>
        <ScheduleExecutionMenuItems
          schedule={schedule}
          canRun={canRun}
          pending={pending}
          onPause={onPause}
          onResume={onResume}
          onRunNow={onRunNow}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel={t("schedules.menu.deleting")}
          onSelect={onDelete}
          testID={`schedule-menu-delete-${schedule.id}`}
        >
          {t(`schedules.kinds.${kind}.delete`)}
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
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  leading: {
    width: PROVIDER_ICON_SIZE,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  target: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
