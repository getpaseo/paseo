import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, History, Pencil, Play, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import type { ScheduleRun, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getHostPickerLabel, HostPicker, HostStatusDotSlot } from "@/components/hosts/host-picker";
import { ScheduleEditModal } from "@/screens/settings/schedule-edit-modal";
import { formatCadenceSummary } from "@/components/schedule-cadence";
import { useScheduleDetail, useScheduleMutations, useSchedules } from "@/hooks/use-schedules";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { isElectronRuntime } from "@/desktop/host";
import type { HostProfile } from "@/types/host-connection";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);
const ThemedPlay = withUnistyles(Play);
const ThemedHistory = withUnistyles(History);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const newIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const runNowIcon = <ThemedPlay size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const viewRunsIcon = <ThemedHistory size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const deleteIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;

function formatTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString();
}

function resolveScheduleStatusLabel(status: ScheduleSummary["status"], t: TFunction): string {
  if (status === "active") {
    return t("settings.host.schedules.status.active");
  }
  if (status === "paused") {
    return t("settings.host.schedules.status.paused");
  }
  return t("settings.host.schedules.status.completed");
}

function resolveRunStatusLabel(status: ScheduleRun["status"], t: TFunction): string {
  if (status === "running") {
    return t("settings.host.schedules.runStatus.running");
  }
  if (status === "succeeded") {
    return t("settings.host.schedules.runStatus.succeeded");
  }
  return t("settings.host.schedules.runStatus.failed");
}

export function SchedulesScreen() {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <SchedulesScreenContent />;
}

function SchedulesScreenContent() {
  const { t } = useTranslation();
  const isDesktop = isElectronRuntime();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const [selectedHost, setSelectedHost] = useState<string | null>(null);

  const resolvedServerId = useMemo(() => {
    if (selectedHost && hosts.some((host) => host.serverId === selectedHost)) {
      return selectedHost;
    }
    if (localServerId && hosts.some((host) => host.serverId === localServerId)) {
      return localServerId;
    }
    return hosts[0]?.serverId ?? null;
  }, [selectedHost, localServerId, hosts]);

  const isConnected = useHostRuntimeIsConnected(resolvedServerId ?? "");
  const { schedules, isLoading, error } = useSchedules(resolvedServerId);
  const mutations = useScheduleMutations(resolvedServerId);

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleSummary | null>(null);
  const [runsScheduleId, setRunsScheduleId] = useState<string | null>(null);

  const handleCreate = useCallback(() => {
    setEditingSchedule(null);
    setEditorVisible(true);
  }, []);

  const handleEdit = useCallback((schedule: ScheduleSummary) => {
    setEditingSchedule(schedule);
    setEditorVisible(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorVisible(false);
    setEditingSchedule(null);
  }, []);

  const handleViewRuns = useCallback((scheduleId: string) => {
    setRunsScheduleId(scheduleId);
  }, []);

  const handleCloseRuns = useCallback(() => {
    setRunsScheduleId(null);
  }, []);

  const canCreate = isDesktop && Boolean(resolvedServerId) && isConnected;
  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={newIcon}
        onPress={handleCreate}
        disabled={!canCreate}
        testID="schedules-add-button"
      >
        {t("settings.host.schedules.create")}
      </Button>
    ),
    [canCreate, handleCreate, t],
  );

  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader
        title={t("settings.hostSections.schedules")}
        rightContent={isDesktop ? addButton : undefined}
      />
      {isDesktop && showHostFilter && resolvedServerId ? (
        <View style={styles.filterContainer}>
          <SchedulesHostFilter
            hosts={hosts}
            selectedHost={resolvedServerId}
            onSelectHost={setSelectedHost}
          />
        </View>
      ) : null}

      <SchedulesBody
        isDesktop={isDesktop}
        serverId={resolvedServerId}
        isConnected={isConnected}
        schedules={schedules}
        isLoading={isLoading}
        error={error}
        onEdit={handleEdit}
        onViewRuns={handleViewRuns}
        onPause={mutations.pause}
        onResume={mutations.resume}
        onRunOnce={mutations.runOnce}
        onDelete={mutations.remove}
      />

      {resolvedServerId ? (
        <ScheduleEditModal
          visible={editorVisible}
          serverId={resolvedServerId}
          schedule={editingSchedule}
          onClose={handleCloseEditor}
        />
      ) : null}

      {resolvedServerId ? (
        <ScheduleRunsModal
          serverId={resolvedServerId}
          scheduleId={runsScheduleId}
          onClose={handleCloseRuns}
        />
      ) : null}
    </View>
  );
}

function SchedulesHostFilter({
  hosts,
  selectedHost,
  onSelectHost,
}: {
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
}) {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const selectedHostLabel = useMemo(
    () => getHostPickerLabel(hosts, selectedHost),
    [hosts, selectedHost],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const filterTriggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.filterTrigger,
      Boolean(hovered) && styles.filterTriggerHovered,
      pressed && styles.filterTriggerPressed,
    ],
    [],
  );

  return (
    <HostPicker
      hosts={hosts}
      value={selectedHost}
      onSelect={onSelectHost}
      open={isFilterOpen}
      onOpenChange={setIsFilterOpen}
      anchorRef={filterAnchorRef}
      searchable={false}
      title="Run on host"
      desktopPlacement="bottom-start"
    >
      <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
        <Pressable
          onPress={handleFilterOpen}
          style={filterTriggerStyle}
          testID="schedules-host-filter-trigger"
          accessibilityRole="button"
          accessibilityLabel={`Host: ${selectedHostLabel}`}
        >
          <HostStatusDotSlot serverId={selectedHost} />
          <Text style={styles.filterTriggerText} numberOfLines={1}>
            {selectedHostLabel}
          </Text>
          <FilterChevron />
        </Pressable>
      </View>
    </HostPicker>
  );
}

function FilterChevron() {
  const { theme } = useUnistyles();
  return <ChevronDown size={14} color={theme.colors.foregroundMuted} />;
}

interface SchedulesBodyProps {
  isDesktop: boolean;
  serverId: string | null;
  isConnected: boolean;
  schedules: ScheduleSummary[];
  isLoading: boolean;
  error: string | null;
  onEdit: (schedule: ScheduleSummary) => void;
  onViewRuns: (scheduleId: string) => void;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onRunOnce: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function SchedulesBody({
  isDesktop,
  serverId,
  isConnected,
  schedules,
  isLoading,
  error,
  onEdit,
  onViewRuns,
  onPause,
  onResume,
  onRunOnce,
  onDelete,
}: SchedulesBodyProps) {
  const { t } = useTranslation();

  if (!isDesktop) {
    return (
      <View style={styles.centeredCard}>
        <Text style={styles.emptyText}>{t("settings.host.schedules.desktopOnly")}</Text>
      </View>
    );
  }
  if (!serverId || !isConnected) {
    return (
      <View style={styles.centeredCard}>
        <Text style={styles.emptyText}>{t("settings.host.schedules.unavailable")}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={settingsStyles.card} testID="schedules-card">
        <ScheduleListContent
          error={error}
          isLoading={isLoading}
          schedules={schedules}
          onEdit={onEdit}
          onViewRuns={onViewRuns}
          onPause={onPause}
          onResume={onResume}
          onRunOnce={onRunOnce}
          onDelete={onDelete}
        />
      </View>
    </ScrollView>
  );
}

interface ScheduleListContentProps {
  error: string | null;
  isLoading: boolean;
  schedules: ScheduleSummary[];
  onEdit: (schedule: ScheduleSummary) => void;
  onViewRuns: (scheduleId: string) => void;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onRunOnce: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function ScheduleListContent({
  error,
  isLoading,
  schedules,
  onEdit,
  onViewRuns,
  onPause,
  onResume,
  onRunOnce,
  onDelete,
}: ScheduleListContentProps) {
  const { t } = useTranslation();
  if (error) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  if (schedules.length === 0) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyText}>
          {isLoading
            ? t("settings.host.schedules.loading")
            : t("settings.host.schedules.emptyState")}
        </Text>
      </View>
    );
  }
  return (
    <>
      {schedules.map((schedule, index) => (
        <ScheduleRow
          key={schedule.id}
          schedule={schedule}
          isFirst={index === 0}
          onEdit={onEdit}
          onViewRuns={onViewRuns}
          onPause={onPause}
          onResume={onResume}
          onRunOnce={onRunOnce}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

interface ScheduleRowProps {
  schedule: ScheduleSummary;
  isFirst: boolean;
  onEdit: (schedule: ScheduleSummary) => void;
  onViewRuns: (scheduleId: string) => void;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onRunOnce: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function ScheduleRow({
  schedule,
  isFirst,
  onEdit,
  onViewRuns,
  onPause,
  onResume,
  onRunOnce,
  onDelete,
}: ScheduleRowProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isBusy, setIsBusy] = useState(false);

  const isCompleted = schedule.status === "completed";
  const isActive = schedule.status === "active";
  // The edit modal can only represent "new-agent" targets; saving it always
  // writes a newAgentConfig block. Offering Edit on an "agent" target (only
  // creatable via CLI/MCP) would open a blank form and silently convert the
  // target type on save, so hide Edit for anything the modal can't round-trip.
  const isEditable = schedule.target.type === "new-agent";
  const title =
    schedule.name?.trim() || schedule.prompt.trim() || t("settings.host.schedules.untitled");
  const cadenceSummary = formatCadenceSummary(schedule.cadence);
  const nextRunText = isActive ? formatTimestamp(schedule.nextRunAt) : null;
  const statusLabel = resolveScheduleStatusLabel(schedule.status, t);

  // Run a row mutation and surface any daemon error as a toast — the mutations
  // throw on failure but have no onError, so the call site is the only place
  // the user can be told the action didn't take effect.
  const runRowAction = useCallback(
    async (action: Promise<void>) => {
      setIsBusy(true);
      try {
        await action;
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setIsBusy(false);
      }
    },
    [toast],
  );

  const handleToggle = useCallback(
    (next: boolean) => {
      if (isBusy || isCompleted) return;
      void runRowAction(next ? onResume(schedule.id) : onPause(schedule.id));
    },
    [isBusy, isCompleted, onPause, onResume, runRowAction, schedule.id],
  );

  const handleRunOnce = useCallback(() => {
    if (isBusy) return;
    void runRowAction(onRunOnce(schedule.id));
  }, [isBusy, onRunOnce, runRowAction, schedule.id]);

  const handleEdit = useCallback(() => onEdit(schedule), [onEdit, schedule]);
  const handleViewRuns = useCallback(() => onViewRuns(schedule.id), [onViewRuns, schedule.id]);

  const handleDelete = useCallback(() => {
    void confirmDialog({
      title: t("settings.host.schedules.deleteConfirmTitle"),
      message: t("settings.host.schedules.deleteConfirmMessage", { name: title }),
      confirmLabel: t("settings.host.schedules.delete"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      void runRowAction(onDelete(schedule.id));
      return;
    });
  }, [onDelete, runRowAction, schedule.id, t, title]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.row],
    [isFirst],
  );

  return (
    <View style={rowStyle} testID={`schedule-row-${schedule.id}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {statusLabel} · {cadenceSummary}
          {nextRunText ? ` · ${t("settings.host.schedules.nextRun", { time: nextRunText })}` : ""}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Switch
          value={isActive}
          onValueChange={handleToggle}
          disabled={isBusy || isCompleted}
          accessibilityLabel={t("settings.host.schedules.toggleAccessibility")}
          testID={`schedule-toggle-${schedule.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={runNowIcon}
          onPress={handleRunOnce}
          disabled={isBusy || isCompleted}
          accessibilityLabel={t("settings.host.schedules.runNow")}
          testID={`schedule-run-now-${schedule.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={viewRunsIcon}
          onPress={handleViewRuns}
          accessibilityLabel={t("settings.host.schedules.viewRuns")}
          testID={`schedule-view-runs-${schedule.id}`}
        />
        {isEditable ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={editIcon}
            onPress={handleEdit}
            disabled={isBusy}
            accessibilityLabel={t("settings.host.schedules.edit")}
            testID={`schedule-edit-${schedule.id}`}
          />
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={deleteIcon}
          onPress={handleDelete}
          disabled={isBusy}
          accessibilityLabel={t("settings.host.schedules.delete")}
          testID={`schedule-delete-${schedule.id}`}
        />
      </View>
    </View>
  );
}

function ScheduleRunsModal({
  serverId,
  scheduleId,
  onClose,
}: {
  serverId: string;
  scheduleId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { schedule, isLoading, error } = useScheduleDetail(serverId, scheduleId);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.schedules.runsTitle") }),
    [t],
  );

  const runs = useMemo(() => {
    if (!schedule) return [];
    return [...schedule.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }, [schedule]);

  if (!scheduleId) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="schedule-runs-modal"
      desktopMaxWidth={560}
    >
      <View style={styles.runsBody}>
        <ScheduleRunsContent error={error} isLoading={isLoading} runs={runs} />
      </View>
    </AdaptiveModalSheet>
  );
}

function ScheduleRunsContent({
  error,
  isLoading,
  runs,
}: {
  error: string | null;
  isLoading: boolean;
  runs: ScheduleRun[];
}) {
  const { t } = useTranslation();
  if (error) {
    return <Text style={styles.errorText}>{error}</Text>;
  }
  if (isLoading && runs.length === 0) {
    return <Text style={styles.emptyText}>{t("settings.host.schedules.loading")}</Text>;
  }
  if (runs.length === 0) {
    return <Text style={styles.emptyText}>{t("settings.host.schedules.noRuns")}</Text>;
  }
  return (
    <>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </>
  );
}

function RunRow({ run }: { run: ScheduleRun }) {
  const { t } = useTranslation();
  const startedText = formatTimestamp(run.startedAt);
  const statusLabel = resolveRunStatusLabel(run.status, t);
  const detail = run.error ?? run.output ?? null;

  return (
    <View style={styles.runRow} testID={`schedule-run-${run.id}`}>
      <View style={styles.runHeader}>
        <Text style={styles.runStatus}>{statusLabel}</Text>
        {startedText ? <Text style={styles.runTime}>{startedText}</Text> : null}
      </View>
      {detail ? (
        <Text style={styles.runDetail} numberOfLines={6}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterContainer: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  filterTriggerWrap: {
    alignSelf: "flex-start",
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  scrollContent: {
    padding: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
  },
  centeredCard: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  row: {
    minHeight: 56,
    gap: theme.spacing[2],
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  runsBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  runRow: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  runHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  runStatus: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  runTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  runDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
