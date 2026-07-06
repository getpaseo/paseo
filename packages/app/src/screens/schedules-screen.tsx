import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { SchedulesTable, type ScheduleRowView } from "@/components/schedules/schedules-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  useSchedules,
  type AggregatedSchedule,
  type ScheduleHostError,
} from "@/hooks/use-schedules";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  resolveSchedule,
  type ScheduleBucket,
  type ScheduleTargetAgent,
} from "@/schedules/schedule-derivation";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
} from "@/schedules/schedule-project-targets";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; serverId: string; schedule: ScheduleSummary };

const STATUS_FILTER_OPTIONS: { value: ScheduleBucket; label: string; testID: string }[] = [
  { value: "runnable", label: "Active", testID: "schedules-filter-active" },
  { value: "ended", label: "Ended", testID: "schedules-filter-ended" },
];

export function SchedulesScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SchedulesScreenContent />;
}

function SchedulesScreenContent(): ReactElement {
  const { schedules, hostErrors, isInitialLoad, isError, refetch } = useSchedules();
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const { projects } = useProjects();
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  // Per-host agent-directory readiness from the runtime, not the aggregate agent
  // flag: the aggregate `isInitialLoad` flips false as soon as *any* host has
  // agents, so a still-loading host would falsely mark its agent-target
  // schedules "gone". `hasEverLoadedAgentDirectory` is true only once that
  // host's directory has loaded at least once.
  const agentDirReadyHosts = useMemo(() => {
    void runtimeVersion;
    const ready = new Set<string>();
    for (const host of hosts) {
      if (runtime.getSnapshot(host.serverId)?.hasEverLoadedAgentDirectory) {
        ready.add(host.serverId);
      }
    }
    return ready;
  }, [hosts, runtime, runtimeVersion]);

  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [statusFilter, setStatusFilter] = useState<ScheduleBucket>("runnable");

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const openCreate = useCallback(() => setForm({ mode: "create" }), []);
  const openEdit = useCallback((schedule: AggregatedSchedule) => {
    setForm({ mode: "edit", serverId: schedule.serverId, schedule });
  }, []);
  const closeForm = useCallback(() => setForm({ mode: "closed" }), []);

  const agentsByKey = useMemo(() => {
    const map = new Map<string, ScheduleTargetAgent>();
    for (const agent of agents) {
      map.set(`${agent.serverId}:${agent.id}`, { title: agent.title, provider: agent.provider });
    }
    return map;
  }, [agents]);

  const projectNameByCwd = useMemo(
    () => buildProjectNameByCwd(buildScheduleProjectTargets(projects)),
    [projects],
  );

  // Resolve every schedule's derived state and target line once, then partition
  // by the host and status filters. Sorted newest-first for a stable order
  // across hosts.
  const resolvedRows = useMemo(() => {
    const now = Date.now();
    return schedules.map((schedule) => ({
      schedule,
      resolved: resolveSchedule({
        schedule,
        serverId: schedule.serverId,
        now,
        agentsByKey,
        projectNameByCwd,
        agentDataLoaded: agentDirReadyHosts.has(schedule.serverId),
      }),
    }));
  }, [schedules, agentsByKey, projectNameByCwd, agentDirReadyHosts]);

  const visibleRows = useMemo<ScheduleRowView[]>(() => {
    const singleHost = hosts.length <= 1;
    return resolvedRows
      .filter(
        ({ schedule, resolved }) =>
          (selectedHost === ALL_HOSTS_OPTION_ID || schedule.serverId === selectedHost) &&
          resolved.bucket === statusFilter,
      )
      .sort((a, b) => Date.parse(b.schedule.createdAt) - Date.parse(a.schedule.createdAt))
      .map(({ schedule, resolved }) => ({
        schedule,
        targetLabel: resolved.target.label,
        provider: resolved.target.provider,
        state: resolved.state,
        serverName: schedule.serverName,
        singleHost,
      }));
  }, [resolvedRows, selectedHost, statusFilter, hosts.length]);

  const showLoadError = isError && schedules.length === 0;
  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader title="Schedules" />
      <SchedulesScreenBody
        rows={visibleRows}
        hostErrors={hostErrors}
        hasSchedules={schedules.length > 0}
        isInitialLoad={isInitialLoad}
        showLoadError={showLoadError}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
      />
      <ScheduleFormSheet
        serverId={form.mode === "edit" ? form.serverId : undefined}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        schedule={form.mode === "edit" ? form.schedule : undefined}
      />
    </View>
  );
}

function SchedulesScreenBody({
  rows,
  hostErrors,
  hasSchedules,
  isInitialLoad,
  showLoadError,
  statusFilter,
  onStatusFilterChange,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  onCreate,
  onEdit,
}: {
  rows: ScheduleRowView[];
  hostErrors: ScheduleHostError[];
  hasSchedules: boolean;
  isInitialLoad: boolean;
  showLoadError: boolean;
  statusFilter: ScheduleBucket;
  onStatusFilterChange: (value: ScheduleBucket) => void;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (schedule: AggregatedSchedule) => void;
}): ReactElement {
  if (isInitialLoad) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (showLoadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Unable to load schedules</Text>
        <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
          Try again
        </Button>
      </View>
    );
  }

  if (!hasSchedules) {
    return (
      <View style={styles.centered} testID="schedules-empty">
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        <Text style={styles.message}>No schedules yet</Text>
        <Button variant="ghost" leftIcon={Plus} onPress={onCreate} testID="schedules-empty-new">
          Create a schedule
        </Button>
      </View>
    );
  }

  const emptyFilterText = statusFilter === "ended" ? "No ended schedules" : "No active schedules";

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        <View style={styles.filterRowControls}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="schedules-host-filter-trigger"
            />
          ) : null}
          <SegmentedControl
            size="sm"
            value={statusFilter}
            onValueChange={onStatusFilterChange}
            options={STATUS_FILTER_OPTIONS}
            testID="schedules-status-filter"
          />
        </View>
        <Button leftIcon={Plus} onPress={onCreate} size="sm" testID="schedules-new">
          New schedule
        </Button>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="schedules-list"
      >
        {hostErrors.length > 0 ? <ScheduleHostErrorsBanner errors={hostErrors} /> : null}
        {rows.length > 0 ? (
          <SchedulesTable rows={rows} onEditSchedule={onEdit} />
        ) : (
          <View style={styles.filterEmpty}>
            <Text style={styles.filterEmptyText}>{emptyFilterText}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function ScheduleHostErrorsBanner({ errors }: { errors: ScheduleHostError[] }): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="schedules-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {`${error.serverName}: Could not load schedules`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  filterRowControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
    flexWrap: "wrap",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  filterEmpty: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  filterEmptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
