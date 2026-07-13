import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronLeft, ChevronRight, Settings2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HostProfile } from "@/types/host-connection";
import type { Theme } from "@/styles/theme";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  useHistoryViewStore,
  type HistoryGroupMode,
  type HistoryLastActivityFilter,
  type HistorySortMode,
  type HistoryStatusFilter,
} from "@/stores/history-view-store";

export interface HistoryProjectOption {
  projectKey: string;
  projectName: string;
}

type MenuPage = "main" | "status" | "project" | "host" | "activity" | "group" | "sort";

interface HistoryPreferenceOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

const ThemedSettings2 = withUnistyles(Settings2);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const backLeading = <ThemedChevronLeft size={14} uniProps={mutedColorMapping} />;

const STATUS_OPTIONS: Array<HistoryPreferenceOption<HistoryStatusFilter>> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];
const ACTIVITY_OPTIONS: Array<HistoryPreferenceOption<HistoryLastActivityFilter>> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days" },
];
const GROUP_OPTIONS: Array<{ value: HistoryGroupMode; label: string }> = [
  { value: "last_activity", label: "Last activity" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];
const SORT_OPTIONS: Array<{ value: HistorySortMode; label: string }> = [
  { value: "alphabetical", label: "Alphabetically" },
  { value: "created", label: "Created time" },
  { value: "recency", label: "Recency" },
];

function selectedCountLabel(keys: readonly string[], labels: ReadonlyMap<string, string>): string {
  if (keys.length === 0) return "All";
  if (keys.length === 1) return labels.get(keys[0] ?? "") ?? "1 selected";
  return `${keys.length} selected`;
}

export function HistoryDisplayPreferencesMenu({
  hosts,
  projects,
}: {
  hosts: readonly HostProfile[];
  projects: readonly HistoryProjectOption[];
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<MenuPage>("main");
  const status = useHistoryViewStore((state) => state.status);
  const projectFilters = useHistoryViewStore((state) => state.projectFilters);
  const hostFilters = useHistoryViewStore((state) => state.hostFilters);
  const lastActivity = useHistoryViewStore((state) => state.lastActivity);
  const groupMode = useHistoryViewStore((state) => state.groupMode);
  const sortMode = useHistoryViewStore((state) => state.sortMode);
  const setStatus = useHistoryViewStore((state) => state.setStatus);
  const setLastActivity = useHistoryViewStore((state) => state.setLastActivity);
  const clearFilters = useHistoryViewStore((state) => state.clearFilters);

  const selectedServerIds = useMemo(() => {
    const availableIds = hosts.map((host) => host.serverId);
    if (hostFilters.length === 0) return availableIds;
    const selected = new Set(hostFilters);
    return availableIds.filter((serverId) => selected.has(serverId));
  }, [hostFilters, hosts]);
  const historyOrganizationAvailability = useHostFeatureAvailabilityMap(
    selectedServerIds,
    "agentHistoryOrganization",
  );
  const hasUnsupportedHistoryOrganizationHost = selectedServerIds.some(
    (serverId) => historyOrganizationAvailability.get(serverId) === "unsupported",
  );
  const statusOptions = useMemo(
    () =>
      STATUS_OPTIONS.map((option) => ({
        ...option,
        label:
          option.value === "archived" && hasUnsupportedHistoryOrganizationHost
            ? `${option.label} · Update host`
            : option.label,
        disabled: option.value === "archived" && hasUnsupportedHistoryOrganizationHost,
      })),
    [hasUnsupportedHistoryOrganizationHost],
  );
  const activityOptions = useMemo(
    () =>
      ACTIVITY_OPTIONS.map((option) => ({
        ...option,
        label:
          option.value !== "any" && hasUnsupportedHistoryOrganizationHost
            ? `${option.label} · Update host`
            : option.label,
        disabled: option.value !== "any" && hasUnsupportedHistoryOrganizationHost,
      })),
    [hasUnsupportedHistoryOrganizationHost],
  );

  useEffect(() => {
    if (!hasUnsupportedHistoryOrganizationHost) return;
    if (status === "archived") setStatus("all");
    if (lastActivity !== "any") setLastActivity("any");
  }, [hasUnsupportedHistoryOrganizationHost, lastActivity, setLastActivity, setStatus, status]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setPage("main");
  }, []);
  const handleBack = useCallback(() => setPage("main"), []);
  const projectLabels = useMemo(
    () => new Map(projects.map((project) => [project.projectKey, project.projectName])),
    [projects],
  );
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label?.trim() || host.serverId])),
    [hosts],
  );
  const hasFilters =
    status !== "all" ||
    projectFilters.length > 0 ||
    hostFilters.length > 0 ||
    lastActivity !== "any";

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel="History filters and sorting"
        testID="history-display-preferences-trigger"
      >
        <ThemedSettings2 size={16} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={280} testID="history-display-preferences-menu">
        {page === "main" ? (
          <>
            <NestedMenuItem
              label="Status"
              value={statusLabel(status)}
              page="status"
              onSelect={setPage}
            />
            <NestedMenuItem
              label="Project"
              value={selectedCountLabel(projectFilters, projectLabels)}
              page="project"
              onSelect={setPage}
            />
            <NestedMenuItem
              label="Host"
              value={selectedCountLabel(hostFilters, hostLabels)}
              page="host"
              onSelect={setPage}
            />
            <NestedMenuItem
              label="Last activity"
              value={activityLabel(lastActivity)}
              page="activity"
              onSelect={setPage}
            />
            <DropdownMenuSeparator />
            <NestedMenuItem
              label="Group by"
              value={groupLabel(groupMode)}
              page="group"
              onSelect={setPage}
            />
            <NestedMenuItem
              label="Sort by"
              value={sortLabel(sortMode)}
              page="sort"
              onSelect={setPage}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!hasFilters} onSelect={clearFilters}>
              Clear filters
            </DropdownMenuItem>
          </>
        ) : (
          <HistorySubmenu
            page={page}
            hosts={hosts}
            projects={projects}
            statusOptions={statusOptions}
            activityOptions={activityOptions}
            onBack={handleBack}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NestedMenuItem({
  label,
  value,
  page,
  onSelect,
}: {
  label: string;
  value: string;
  page: Exclude<MenuPage, "main">;
  onSelect: (page: MenuPage) => void;
}) {
  const trailing = useMemo(
    () => (
      <View style={styles.trailingValue}>
        <Text style={styles.trailingText} numberOfLines={1}>
          {value}
        </Text>
        <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
      </View>
    ),
    [value],
  );
  const handleSelect = useCallback(() => onSelect(page), [onSelect, page]);
  return (
    <DropdownMenuItem closeOnSelect={false} trailing={trailing} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function HistorySubmenu({
  page,
  hosts,
  projects,
  statusOptions,
  activityOptions,
  onBack,
}: {
  page: Exclude<MenuPage, "main">;
  hosts: readonly HostProfile[];
  projects: readonly HistoryProjectOption[];
  statusOptions: ReadonlyArray<HistoryPreferenceOption<HistoryStatusFilter>>;
  activityOptions: ReadonlyArray<HistoryPreferenceOption<HistoryLastActivityFilter>>;
  onBack: () => void;
}) {
  return (
    <>
      <DropdownMenuItem closeOnSelect={false} leading={backLeading} onSelect={onBack}>
        {submenuTitle(page)}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {page === "status" ? <StatusItems options={statusOptions} /> : null}
      {page === "project" ? <ProjectItems projects={projects} /> : null}
      {page === "host" ? <HostItems hosts={hosts} /> : null}
      {page === "activity" ? <ActivityItems options={activityOptions} /> : null}
      {page === "group" ? <GroupItems /> : null}
      {page === "sort" ? <SortItems /> : null}
    </>
  );
}

function SingleSelectItems<Value extends string>({
  options,
  selected,
  onSelect,
}: {
  options: ReadonlyArray<HistoryPreferenceOption<Value>>;
  selected: Value;
  onSelect: (value: Value) => void;
}) {
  return options.map((option) => (
    <SingleSelectItem
      key={option.value}
      option={option}
      selected={option.value === selected}
      disabled={option.disabled}
      onSelect={onSelect}
    />
  ));
}

function SingleSelectItem<Value extends string>({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: HistoryPreferenceOption<Value>;
  selected: boolean;
  disabled?: boolean;
  onSelect: (value: Value) => void;
}) {
  const handleSelect = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  return (
    <DropdownMenuItem selected={selected} disabled={disabled} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

function StatusItems({
  options,
}: {
  options: ReadonlyArray<HistoryPreferenceOption<HistoryStatusFilter>>;
}) {
  const selected = useHistoryViewStore((state) => state.status);
  const setStatus = useHistoryViewStore((state) => state.setStatus);
  return <SingleSelectItems options={options} selected={selected} onSelect={setStatus} />;
}

function ActivityItems({
  options,
}: {
  options: ReadonlyArray<HistoryPreferenceOption<HistoryLastActivityFilter>>;
}) {
  const selected = useHistoryViewStore((state) => state.lastActivity);
  const setLastActivity = useHistoryViewStore((state) => state.setLastActivity);
  return <SingleSelectItems options={options} selected={selected} onSelect={setLastActivity} />;
}

function GroupItems() {
  const selected = useHistoryViewStore((state) => state.groupMode);
  const setGroupMode = useHistoryViewStore((state) => state.setGroupMode);
  return <SingleSelectItems options={GROUP_OPTIONS} selected={selected} onSelect={setGroupMode} />;
}

function SortItems() {
  const selected = useHistoryViewStore((state) => state.sortMode);
  const setSortMode = useHistoryViewStore((state) => state.setSortMode);
  return <SingleSelectItems options={SORT_OPTIONS} selected={selected} onSelect={setSortMode} />;
}

function ProjectItems({ projects }: { projects: readonly HistoryProjectOption[] }) {
  const selected = useHistoryViewStore((state) => state.projectFilters);
  const toggle = useHistoryViewStore((state) => state.toggleProjectFilter);
  const clear = useHistoryViewStore((state) => state.clearProjectFilters);
  const items = useMemo(
    () => projects.map((project) => ({ key: project.projectKey, label: project.projectName })),
    [projects],
  );
  return (
    <MultiSelectItems
      allSelected={selected.length === 0}
      items={items}
      selected={selected}
      onClear={clear}
      onToggle={toggle}
    />
  );
}

function HostItems({ hosts }: { hosts: readonly HostProfile[] }) {
  const selected = useHistoryViewStore((state) => state.hostFilters);
  const toggle = useHistoryViewStore((state) => state.toggleHostFilter);
  const clear = useHistoryViewStore((state) => state.clearHostFilters);
  const items = useMemo(
    () =>
      hosts.map((host) => ({
        key: host.serverId,
        label: host.label?.trim() || host.serverId,
      })),
    [hosts],
  );
  return (
    <MultiSelectItems
      allSelected={selected.length === 0}
      items={items}
      selected={selected}
      onClear={clear}
      onToggle={toggle}
    />
  );
}

function MultiSelectItems({
  allSelected,
  items,
  selected,
  onClear,
  onToggle,
}: {
  allSelected: boolean;
  items: ReadonlyArray<{ key: string; label: string }>;
  selected: readonly string[];
  onClear: () => void;
  onToggle: (key: string) => void;
}) {
  return (
    <>
      <DropdownMenuItem selected={allSelected} closeOnSelect={false} onSelect={onClear}>
        All
      </DropdownMenuItem>
      {items.map((item) => (
        <MultiSelectItem
          key={item.key}
          item={item}
          selected={selected.includes(item.key)}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function MultiSelectItem({
  item,
  selected,
  onToggle,
}: {
  item: { key: string; label: string };
  selected: boolean;
  onToggle: (key: string) => void;
}) {
  const handleSelect = useCallback(() => onToggle(item.key), [item.key, onToggle]);
  return (
    <DropdownMenuItem selected={selected} closeOnSelect={false} onSelect={handleSelect}>
      {item.label}
    </DropdownMenuItem>
  );
}

function statusLabel(value: HistoryStatusFilter): string {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "All";
}

function activityLabel(value: HistoryLastActivityFilter): string {
  return ACTIVITY_OPTIONS.find((option) => option.value === value)?.label ?? "Any time";
}

function groupLabel(value: HistoryGroupMode): string {
  return GROUP_OPTIONS.find((option) => option.value === value)?.label ?? "Last activity";
}

function sortLabel(value: HistorySortMode): string {
  return SORT_OPTIONS.find((option) => option.value === value)?.label ?? "Recency";
}

function submenuTitle(page: Exclude<MenuPage, "main">): string {
  switch (page) {
    case "status":
      return "Status";
    case "project":
      return "Project";
    case "host":
      return "Host";
    case "activity":
      return "Last activity";
    case "group":
      return "Group by";
    case "sort":
      return "Sort by";
  }
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  trailingValue: {
    maxWidth: 156,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  trailingText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
