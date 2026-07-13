import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, ChevronRight, Settings2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostStatusDot } from "@/components/host-status-dot";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { useAppSettings, type WorkspaceTitleSource } from "@/hooks/use-settings";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  useSidebarViewStore,
  type SidebarGroupMode,
  type SidebarLastActivityFilter,
  type SidebarSortMode,
  type SidebarStatusFilter,
  type SidebarVisibilityFilter,
} from "@/stores/sidebar-view-store";
import { useSidebarProjectPreferencesStore } from "@/stores/sidebar-project-preferences-store";
import { normalizeWorkspaceCollection, useSessionStore } from "@/stores/session-store";

const ThemedSettings2 = withUnistyles(Settings2);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const filterColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const backLeading = <ThemedChevronLeft size={14} uniProps={filterColorMapping} />;

type MenuPage =
  | "root"
  | "status"
  | "visibility"
  | "project"
  | "host"
  | "activity"
  | "group"
  | "sort"
  | "workspace-title";

interface DisplayPreferenceOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

const STATUS_ITEMS: Array<DisplayPreferenceOption<SidebarStatusFilter>> = [
  { value: "needs_input", label: "Needs input" },
  { value: "running", label: "Working" },
  { value: "attention", label: "Ready to review" },
  { value: "failed", label: "Failed" },
  { value: "done", label: "Done" },
];
const VISIBILITY_ITEMS: Array<DisplayPreferenceOption<SidebarVisibilityFilter>> = [
  { value: "visible", label: "Visible" },
  { value: "hidden", label: "Hidden" },
  { value: "all", label: "All" },
];
const ACTIVITY_ITEMS: Array<DisplayPreferenceOption<SidebarLastActivityFilter>> = [
  { value: "all", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "seven_days", label: "Past 7 days" },
  { value: "thirty_days", label: "Past 30 days" },
];
const GROUP_MODE_ITEMS: Array<DisplayPreferenceOption<SidebarGroupMode>> = [
  { value: "project", label: "Project" },
  { value: "project_collection", label: "Project group" },
  { value: "status", label: "Status" },
  { value: "collection", label: "Workspace label" },
  { value: "none", label: "None" },
];
const SORT_MODE_ITEMS: Array<DisplayPreferenceOption<SidebarSortMode>> = [
  { value: "custom", label: "Custom order" },
  { value: "alphabetical", label: "Alphabetically" },
  { value: "created", label: "Created time" },
  { value: "recency", label: "Recency" },
];
const WORKSPACE_TITLE_SOURCE_ITEMS: Array<DisplayPreferenceOption<WorkspaceTitleSource>> = [
  { value: "title", label: "Title" },
  { value: "branch", label: "Branch name" },
];

function selectedListLabel(
  selected: readonly string[],
  labels: ReadonlyMap<string, string>,
): string {
  if (selected.length === 0) return "All";
  if (selected.length === 1) return labels.get(selected[0] ?? "") ?? "1 selected";
  return `${selected.length} selected`;
}

function MenuValue({ value }: { value: string }): ReactElement {
  return (
    <View style={styles.menuValue}>
      <Text numberOfLines={1} style={styles.menuValueText}>
        {value}
      </Text>
      <ThemedChevronRight size={14} uniProps={filterColorMapping} />
    </View>
  );
}

// oxlint-disable-next-line complexity
export function SidebarDisplayPreferencesMenu() {
  const [page, setPage] = useState<MenuPage>("root");
  const [isCreateProjectCollectionOpen, setIsCreateProjectCollectionOpen] = useState(false);
  const [isCreateWorkspaceCollectionOpen, setIsCreateWorkspaceCollectionOpen] = useState(false);
  const createProjectCollection = useSidebarProjectPreferencesStore(
    (state) => state.createCollection,
  );
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const visibilityFilter = useSidebarViewStore((state) => state.visibilityFilter);
  const lastActivityFilter = useSidebarViewStore((state) => state.lastActivityFilter);
  const statusFilters = useSidebarViewStore((state) => state.statusFilters);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const setSortMode = useSidebarViewStore((state) => state.setSortMode);
  const setVisibilityFilter = useSidebarViewStore((state) => state.setVisibilityFilter);
  const setLastActivityFilter = useSidebarViewStore((state) => state.setLastActivityFilter);
  const toggleStatusFilter = useSidebarViewStore((state) => state.toggleStatusFilter);
  const clearStatusFilters = useSidebarViewStore((state) => state.clearStatusFilters);
  const toggleProjectFilter = useSidebarViewStore((state) => state.toggleProjectFilter);
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  const clearFilters = useSidebarViewStore((state) => state.clearFilters);
  const hosts = useHosts();
  const selectedServerIds = useMemo(() => {
    const availableIds = hosts.map((host) => host.serverId);
    if (hostFilters.length === 0) return availableIds;
    const selected = new Set(hostFilters);
    return availableIds.filter((serverId) => selected.has(serverId));
  }, [hostFilters, hosts]);
  const organizationAvailability = useHostFeatureAvailabilityMap(
    selectedServerIds,
    "workspaceOrganization",
  );
  const hasUnsupportedOrganizationHost = selectedServerIds.some(
    (serverId) => organizationAvailability.get(serverId) === "unsupported",
  );
  const workspaceCollectionServerId =
    selectedServerIds.length === 1 &&
    organizationAvailability.get(selectedServerIds[0] ?? "") !== "unsupported"
      ? (selectedServerIds[0] ?? null)
      : null;
  const { projectNamesByKey } = useSidebarModel();
  const {
    settings: { workspaceTitleSource },
    updateSettings,
  } = useAppSettings();

  const projectItems = useMemo(
    () =>
      Array.from(projectNamesByKey, ([value, label]) => ({ value, label })).sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }),
      ),
    [projectNamesByKey],
  );
  const projectLabels = useMemo(
    () => new Map(projectItems.map((item) => [item.value, item.label])),
    [projectItems],
  );
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label?.trim() || host.serverId])),
    [hosts],
  );
  const statusLabels = useMemo(
    () => new Map(STATUS_ITEMS.map((item) => [item.value, item.label])),
    [],
  );
  const groupModeItems = useMemo(
    () =>
      GROUP_MODE_ITEMS.map((item) => ({
        ...item,
        label:
          item.value === "collection" && hasUnsupportedOrganizationHost
            ? `${item.label} · Update host`
            : item.label,
        disabled: item.value === "collection" && hasUnsupportedOrganizationHost,
      })),
    [hasUnsupportedOrganizationHost],
  );
  const sortModeItems = useMemo(
    () =>
      SORT_MODE_ITEMS.map((item) => ({
        ...item,
        label:
          (item.value === "created" || item.value === "recency") && hasUnsupportedOrganizationHost
            ? `${item.label} · Update host`
            : item.label,
        disabled:
          (item.value === "created" || item.value === "recency") && hasUnsupportedOrganizationHost,
      })),
    [hasUnsupportedOrganizationHost],
  );
  const isFiltered =
    statusFilters.length > 0 ||
    projectFilters.length > 0 ||
    hostFilters.length > 0 ||
    visibilityFilter !== "visible" ||
    lastActivityFilter !== "all";

  useEffect(() => {
    if (!hasUnsupportedOrganizationHost) return;
    if (groupMode === "collection") setGroupMode("project");
    if (sortMode === "created" || sortMode === "recency") setSortMode("custom");
  }, [groupMode, hasUnsupportedOrganizationHost, setGroupMode, setSortMode, sortMode]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setPage("root");
  }, []);
  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
    ],
    [],
  );
  const openPage = useCallback((nextPage: MenuPage) => setPage(nextPage), []);
  const handleBack = useCallback(() => setPage("root"), []);
  const handleWorkspaceTitleSourceSelect = useCallback(
    (source: WorkspaceTitleSource) => void updateSettings({ workspaceTitleSource: source }),
    [updateSettings],
  );
  const handleCreateProjectCollection = useCallback(
    (name: string) => {
      createProjectCollection(name);
      setIsCreateProjectCollectionOpen(false);
    },
    [createProjectCollection],
  );
  const handleOpenCreateProjectCollection = useCallback(
    () => setIsCreateProjectCollectionOpen(true),
    [],
  );
  const handleCloseCreateProjectCollection = useCallback(
    () => setIsCreateProjectCollectionOpen(false),
    [],
  );
  const handleCreateWorkspaceCollection = useCallback(
    async (name: string) => {
      if (!workspaceCollectionServerId) {
        throw new Error("Select one host before creating a workspace label");
      }
      const client = getHostRuntimeStore().getClient(workspaceCollectionServerId);
      if (!client) throw new Error("Host disconnected");
      const collection = await client.createWorkspaceCollection(name.trim());
      const existing =
        useSessionStore.getState().sessions[workspaceCollectionServerId]?.workspaceCollections;
      useSessionStore
        .getState()
        .setWorkspaceCollections(workspaceCollectionServerId, [
          ...Array.from(existing?.values() ?? []).filter((item) => item.id !== collection.id),
          normalizeWorkspaceCollection(collection),
        ]);
      setIsCreateWorkspaceCollectionOpen(false);
    },
    [workspaceCollectionServerId],
  );
  const handleOpenCreateWorkspaceCollection = useCallback(
    () => setIsCreateWorkspaceCollectionOpen(true),
    [],
  );
  const handleCloseCreateWorkspaceCollection = useCallback(
    () => setIsCreateWorkspaceCollectionOpen(false),
    [],
  );

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          style={triggerStyle}
          accessibilityRole={platformIsWeb ? undefined : "button"}
          accessibilityLabel="Display preferences"
          testID="sidebar-display-preferences-menu"
        >
          <ThemedSettings2 size={14} uniProps={filterColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={276} testID="sidebar-display-preferences-content">
          {page === "root" ? (
            <>
              <PageLink
                label="Status"
                value={selectedListLabel(statusFilters, statusLabels)}
                page="status"
                onOpen={openPage}
              />
              <PageLink
                label="Visibility"
                value={
                  VISIBILITY_ITEMS.find((item) => item.value === visibilityFilter)?.label ??
                  "Visible"
                }
                page="visibility"
                onOpen={openPage}
              />
              <PageLink
                label="Project"
                value={selectedListLabel(projectFilters, projectLabels)}
                page="project"
                onOpen={openPage}
              />
              <PageLink
                label="Host"
                value={selectedListLabel(hostFilters, hostLabels)}
                page="host"
                onOpen={openPage}
              />
              <PageLink
                label="Last activity"
                value={
                  ACTIVITY_ITEMS.find((item) => item.value === lastActivityFilter)?.label ??
                  "Any time"
                }
                page="activity"
                onOpen={openPage}
              />
              <DropdownMenuItem
                testID="sidebar-new-project-collection"
                onSelect={handleOpenCreateProjectCollection}
              >
                New project group…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!workspaceCollectionServerId}
                testID="sidebar-new-workspace-collection"
                onSelect={handleOpenCreateWorkspaceCollection}
              >
                {workspaceCollectionServerId
                  ? "New workspace label…"
                  : "New workspace label… · Select one host"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <PageLink
                label="Group by"
                value={
                  GROUP_MODE_ITEMS.find((item) => item.value === groupMode)?.label ?? "Project"
                }
                page="group"
                onOpen={openPage}
              />
              <PageLink
                label="Sort by"
                value={
                  SORT_MODE_ITEMS.find((item) => item.value === sortMode)?.label ?? "Custom order"
                }
                page="sort"
                onOpen={openPage}
              />
              <DropdownMenuSeparator />
              <PageLink
                label="Workspace title"
                value={
                  WORKSPACE_TITLE_SOURCE_ITEMS.find((item) => item.value === workspaceTitleSource)
                    ?.label ?? "Title"
                }
                page="workspace-title"
                onOpen={openPage}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!isFiltered}
                onSelect={clearFilters}
                testID="sidebar-clear-filters"
              >
                Clear filters
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem leading={backLeading} closeOnSelect={false} onSelect={handleBack}>
                {PAGE_LABELS[page]}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {page === "status" ? (
                <MultiSelectPage
                  items={STATUS_ITEMS}
                  selected={statusFilters}
                  onToggle={toggleStatusFilter}
                  onClear={clearStatusFilters}
                  testIDPrefix="sidebar-status-filter"
                />
              ) : null}
              {page === "visibility" ? (
                <SingleSelectPage
                  items={VISIBILITY_ITEMS}
                  selected={visibilityFilter}
                  onSelect={setVisibilityFilter}
                  testIDPrefix="sidebar-visibility-filter"
                />
              ) : null}
              {page === "project" ? (
                <MultiSelectPage
                  items={projectItems}
                  selected={projectFilters}
                  onToggle={toggleProjectFilter}
                  onClear={clearProjectFilters}
                  testIDPrefix="sidebar-project-filter"
                />
              ) : null}
              {page === "host" ? (
                <HostPage
                  hosts={hosts}
                  selected={hostFilters}
                  onToggle={toggleHostFilter}
                  onClear={clearHostFilters}
                />
              ) : null}
              {page === "activity" ? (
                <SingleSelectPage
                  items={ACTIVITY_ITEMS}
                  selected={lastActivityFilter}
                  onSelect={setLastActivityFilter}
                  testIDPrefix="sidebar-activity-filter"
                />
              ) : null}
              {page === "group" ? (
                <SingleSelectPage
                  items={groupModeItems}
                  selected={groupMode}
                  onSelect={setGroupMode}
                  testIDPrefix="sidebar-grouping"
                />
              ) : null}
              {page === "sort" ? (
                <SingleSelectPage
                  items={sortModeItems}
                  selected={sortMode}
                  onSelect={setSortMode}
                  testIDPrefix="sidebar-sort"
                />
              ) : null}
              {page === "workspace-title" ? (
                <SingleSelectPage
                  items={WORKSPACE_TITLE_SOURCE_ITEMS}
                  selected={workspaceTitleSource}
                  onSelect={handleWorkspaceTitleSourceSelect}
                  testIDPrefix="sidebar-workspace-title-source"
                />
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AdaptiveRenameModal
        visible={isCreateProjectCollectionOpen}
        title="New project group"
        initialValue=""
        placeholder="Group name"
        submitLabel="Create"
        onClose={handleCloseCreateProjectCollection}
        onSubmit={handleCreateProjectCollection}
        testID="sidebar-create-project-collection"
      />
      <AdaptiveRenameModal
        visible={isCreateWorkspaceCollectionOpen}
        title="New workspace label"
        initialValue=""
        placeholder="Label name"
        submitLabel="Create"
        onClose={handleCloseCreateWorkspaceCollection}
        onSubmit={handleCreateWorkspaceCollection}
        testID="sidebar-create-workspace-collection"
      />
    </>
  );
}

const PAGE_LABELS: Record<Exclude<MenuPage, "root">, string> = {
  status: "Status",
  visibility: "Visibility",
  project: "Project",
  host: "Host",
  activity: "Last activity",
  group: "Group by",
  sort: "Sort by",
  "workspace-title": "Workspace title",
};

function PageLink({
  label,
  value,
  page,
  onOpen,
}: {
  label: string;
  value: string;
  page: MenuPage;
  onOpen: (page: MenuPage) => void;
}) {
  const handleSelect = useCallback(() => onOpen(page), [onOpen, page]);
  const trailing = useMemo(() => <MenuValue value={value} />, [value]);
  return (
    <DropdownMenuItem closeOnSelect={false} trailing={trailing} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function SingleSelectPage<Value extends string>({
  items,
  selected,
  onSelect,
  testIDPrefix,
}: {
  items: Array<DisplayPreferenceOption<Value>>;
  selected: Value;
  onSelect: (value: Value) => void;
  testIDPrefix: string;
}) {
  return items.map((item) => (
    <DisplayPreferenceMenuItem
      key={item.value}
      item={item}
      isSelected={selected === item.value}
      disabled={item.disabled}
      closeOnSelect={false}
      testIDPrefix={testIDPrefix}
      onSelect={onSelect}
    />
  ));
}

function MultiSelectPage<Value extends string>({
  items,
  selected,
  onToggle,
  onClear,
  testIDPrefix,
}: {
  items: Array<DisplayPreferenceOption<Value>>;
  selected: readonly Value[];
  onToggle: (value: Value) => void;
  onClear: () => void;
  testIDPrefix: string;
}) {
  return (
    <>
      <DropdownMenuItem
        selected={selected.length === 0}
        closeOnSelect={false}
        testID={`${testIDPrefix}-all`}
        onSelect={onClear}
      >
        All
      </DropdownMenuItem>
      {items.map((item) => (
        <DisplayPreferenceMenuItem
          key={item.value}
          item={item}
          isSelected={selected.includes(item.value)}
          closeOnSelect={false}
          testIDPrefix={testIDPrefix}
          onSelect={onToggle}
        />
      ))}
    </>
  );
}

function DisplayPreferenceMenuItem<Value extends string>({
  item,
  isSelected,
  disabled,
  closeOnSelect,
  testIDPrefix,
  onSelect,
}: {
  item: DisplayPreferenceOption<Value>;
  isSelected: boolean;
  disabled?: boolean;
  closeOnSelect: boolean;
  testIDPrefix: string;
  onSelect: (value: Value) => void;
}) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={`${testIDPrefix}-${item.value}`}
      selected={isSelected}
      disabled={disabled}
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

function HostPage({
  hosts,
  selected,
  onToggle,
  onClear,
}: {
  hosts: ReturnType<typeof useHosts>;
  selected: readonly string[];
  onToggle: (serverId: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <DropdownMenuItem
        testID="sidebar-host-filter-all"
        selected={selected.length === 0}
        closeOnSelect={false}
        onSelect={onClear}
      >
        All
      </DropdownMenuItem>
      {hosts.map((host) => (
        <HostFilterItem
          key={host.serverId}
          label={host.label?.trim() || host.serverId}
          serverId={host.serverId}
          selected={selected.includes(host.serverId)}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function HostFilterItem({
  label,
  serverId,
  selected,
  onToggle,
}: {
  label: string;
  serverId: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
}) {
  const handleSelect = useCallback(() => onToggle(serverId), [onToggle, serverId]);
  const leading = useMemo(
    () => (
      <View testID={`sidebar-host-filter-status-${serverId}`}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId],
  );
  return (
    <DropdownMenuItem
      testID={`sidebar-host-filter-${serverId}`}
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
    >
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  menuValue: {
    maxWidth: 156,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  menuValueText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
