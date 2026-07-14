import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Settings2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  displayPreferenceOptionLabel,
  DisplayPreferencePageLinks,
  DisplayPreferenceSubmenu,
  MultiSelectPreferenceItems,
  SingleSelectPreferenceItems,
  type DisplayPreferencePage,
  type DisplayPreferenceOption,
} from "@/components/display-preference-menu-items";
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
const filterColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
type SubmenuPage = Exclude<MenuPage, "root">;

interface SidebarSubmenuDescriptor {
  label: string;
  content: ReactElement;
}

function selectedListLabel(
  selected: readonly string[],
  labels: ReadonlyMap<string, string>,
  t: TFunction,
): string {
  if (selected.length === 0) return t("sidebar.organization.selection.all");
  if (selected.length === 1) {
    return labels.get(selected[0] ?? "") ?? t("sidebar.organization.selection.oneSelected");
  }
  return t("sidebar.organization.selection.selectedCount", { count: selected.length });
}

export function SidebarDisplayPreferencesMenu() {
  const { t } = useTranslation();
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
  const hasUnavailableOrganizationHost = selectedServerIds.some(
    (serverId) => organizationAvailability.get(serverId) !== "supported",
  );
  const workspaceCollectionServerId =
    selectedServerIds.length === 1 &&
    organizationAvailability.get(selectedServerIds[0] ?? "") === "supported"
      ? (selectedServerIds[0] ?? null)
      : null;
  const { projectNamesByKey } = useSidebarModel();
  const {
    settings: { workspaceTitleSource },
    updateSettings,
  } = useAppSettings();

  const statusItems = useMemo<DisplayPreferenceOption<SidebarStatusFilter>[]>(
    () => [
      { value: "needs_input", label: t("sidebar.organization.status.needsInput") },
      { value: "running", label: t("sidebar.organization.status.working") },
      { value: "attention", label: t("sidebar.organization.status.readyToReview") },
      { value: "failed", label: t("sidebar.organization.status.failed") },
      { value: "done", label: t("sidebar.organization.status.done") },
    ],
    [t],
  );
  const visibilityItems = useMemo<DisplayPreferenceOption<SidebarVisibilityFilter>[]>(
    () => [
      { value: "visible", label: t("sidebar.organization.visibility.visible") },
      { value: "hidden", label: t("sidebar.organization.visibility.hidden") },
      { value: "all", label: t("sidebar.organization.selection.all") },
    ],
    [t],
  );
  const activityItems = useMemo<DisplayPreferenceOption<SidebarLastActivityFilter>[]>(
    () => [
      { value: "all", label: t("sidebar.organization.activity.anyTime") },
      { value: "today", label: t("sidebar.organization.activity.today") },
      { value: "seven_days", label: t("sidebar.organization.activity.pastSevenDays") },
      { value: "thirty_days", label: t("sidebar.organization.activity.pastThirtyDays") },
    ],
    [t],
  );
  const baseGroupModeItems = useMemo<DisplayPreferenceOption<SidebarGroupMode>[]>(
    () => [
      { value: "project", label: t("sidebar.organization.group.project") },
      { value: "project_collection", label: t("sidebar.organization.group.projectGroup") },
      { value: "status", label: t("sidebar.organization.group.status") },
      { value: "collection", label: t("sidebar.organization.group.workspaceLabel") },
      { value: "none", label: t("sidebar.organization.group.none") },
    ],
    [t],
  );
  const baseSortModeItems = useMemo<DisplayPreferenceOption<SidebarSortMode>[]>(
    () => [
      { value: "custom", label: t("sidebar.organization.sort.customOrder") },
      { value: "alphabetical", label: t("sidebar.organization.sort.alphabetical") },
      { value: "created", label: t("sidebar.organization.sort.createdTime") },
      { value: "recency", label: t("sidebar.organization.sort.recency") },
    ],
    [t],
  );
  const workspaceTitleSourceItems = useMemo<DisplayPreferenceOption<WorkspaceTitleSource>[]>(
    () => [
      { value: "title", label: t("sidebar.organization.workspaceTitle.title") },
      { value: "branch", label: t("sidebar.organization.workspaceTitle.branchName") },
    ],
    [t],
  );
  const pageLabels = useMemo<Record<Exclude<MenuPage, "root">, string>>(
    () => ({
      status: t("sidebar.organization.labels.status"),
      visibility: t("sidebar.organization.labels.visibility"),
      project: t("sidebar.organization.labels.project"),
      host: t("sidebar.organization.labels.host"),
      activity: t("sidebar.organization.labels.lastActivity"),
      group: t("sidebar.organization.labels.groupBy"),
      sort: t("sidebar.organization.labels.sortBy"),
      "workspace-title": t("sidebar.organization.labels.workspaceTitle"),
    }),
    [t],
  );

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
    () => new Map(statusItems.map((item) => [item.value, item.label])),
    [statusItems],
  );
  const groupModeItems = useMemo(
    () =>
      baseGroupModeItems.map((item) => ({
        ...item,
        label:
          item.value === "collection" && hasUnavailableOrganizationHost
            ? t("sidebar.organization.updateHost", { label: item.label })
            : item.label,
        disabled: item.value === "collection" && hasUnavailableOrganizationHost,
      })),
    [baseGroupModeItems, hasUnavailableOrganizationHost, t],
  );
  const sortModeItems = useMemo(
    () =>
      baseSortModeItems.map((item) => ({
        ...item,
        label:
          (item.value === "created" || item.value === "recency") && hasUnavailableOrganizationHost
            ? t("sidebar.organization.updateHost", { label: item.label })
            : item.label,
        disabled:
          (item.value === "created" || item.value === "recency") && hasUnavailableOrganizationHost,
      })),
    [baseSortModeItems, hasUnavailableOrganizationHost, t],
  );
  const isFiltered =
    statusFilters.length > 0 ||
    projectFilters.length > 0 ||
    hostFilters.length > 0 ||
    visibilityFilter !== "visible" ||
    lastActivityFilter !== "all";
  const filterPages = useMemo<DisplayPreferencePage<SubmenuPage>[]>(
    () => [
      {
        page: "status",
        label: pageLabels.status,
        value: selectedListLabel(statusFilters, statusLabels, t),
      },
      {
        page: "visibility",
        label: pageLabels.visibility,
        value: displayPreferenceOptionLabel(
          visibilityItems,
          visibilityFilter,
          t("sidebar.organization.visibility.visible"),
        ),
      },
      {
        page: "project",
        label: pageLabels.project,
        value: selectedListLabel(projectFilters, projectLabels, t),
      },
      {
        page: "host",
        label: pageLabels.host,
        value: selectedListLabel(hostFilters, hostLabels, t),
      },
      {
        page: "activity",
        label: pageLabels.activity,
        value: displayPreferenceOptionLabel(
          activityItems,
          lastActivityFilter,
          t("sidebar.organization.activity.anyTime"),
        ),
      },
    ],
    [
      activityItems,
      hostFilters,
      hostLabels,
      lastActivityFilter,
      pageLabels,
      projectFilters,
      projectLabels,
      statusFilters,
      statusLabels,
      t,
      visibilityFilter,
      visibilityItems,
    ],
  );
  const organizationPages = useMemo<DisplayPreferencePage<SubmenuPage>[]>(
    () => [
      {
        page: "group",
        label: pageLabels.group,
        value: displayPreferenceOptionLabel(
          baseGroupModeItems,
          groupMode,
          t("sidebar.organization.group.project"),
        ),
      },
      {
        page: "sort",
        label: pageLabels.sort,
        value: displayPreferenceOptionLabel(
          baseSortModeItems,
          sortMode,
          t("sidebar.organization.sort.customOrder"),
        ),
      },
    ],
    [baseGroupModeItems, baseSortModeItems, groupMode, pageLabels, sortMode, t],
  );
  const workspaceTitlePages = useMemo<DisplayPreferencePage<SubmenuPage>[]>(
    () => [
      {
        page: "workspace-title",
        label: pageLabels["workspace-title"],
        value: displayPreferenceOptionLabel(
          workspaceTitleSourceItems,
          workspaceTitleSource,
          t("sidebar.organization.workspaceTitle.title"),
        ),
      },
    ],
    [pageLabels, t, workspaceTitleSource, workspaceTitleSourceItems],
  );

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
        throw new Error(t("sidebar.organization.errors.selectOneHost"));
      }
      const client = getHostRuntimeStore().getClient(workspaceCollectionServerId);
      if (!client) throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
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
    [t, workspaceCollectionServerId],
  );
  const handleOpenCreateWorkspaceCollection = useCallback(
    () => setIsCreateWorkspaceCollectionOpen(true),
    [],
  );
  const handleCloseCreateWorkspaceCollection = useCallback(
    () => setIsCreateWorkspaceCollectionOpen(false),
    [],
  );
  const submenuPages: Record<SubmenuPage, SidebarSubmenuDescriptor> = {
    status: {
      label: pageLabels.status,
      content: (
        <MultiSelectPreferenceItems
          allLabel={t("sidebar.organization.selection.all")}
          items={statusItems}
          selected={statusFilters}
          onToggle={toggleStatusFilter}
          onClear={clearStatusFilters}
          testIDPrefix="sidebar-status-filter"
        />
      ),
    },
    visibility: {
      label: pageLabels.visibility,
      content: (
        <SingleSelectPreferenceItems
          items={visibilityItems}
          selected={visibilityFilter}
          closeOnSelect={false}
          onSelect={setVisibilityFilter}
          testIDPrefix="sidebar-visibility-filter"
        />
      ),
    },
    project: {
      label: pageLabels.project,
      content: (
        <MultiSelectPreferenceItems
          allLabel={t("sidebar.organization.selection.all")}
          items={projectItems}
          selected={projectFilters}
          onToggle={toggleProjectFilter}
          onClear={clearProjectFilters}
          testIDPrefix="sidebar-project-filter"
        />
      ),
    },
    host: {
      label: pageLabels.host,
      content: (
        <HostPage
          hosts={hosts}
          selected={hostFilters}
          onToggle={toggleHostFilter}
          onClear={clearHostFilters}
        />
      ),
    },
    activity: {
      label: pageLabels.activity,
      content: (
        <SingleSelectPreferenceItems
          items={activityItems}
          selected={lastActivityFilter}
          closeOnSelect={false}
          onSelect={setLastActivityFilter}
          testIDPrefix="sidebar-activity-filter"
        />
      ),
    },
    group: {
      label: pageLabels.group,
      content: (
        <SingleSelectPreferenceItems
          items={groupModeItems}
          selected={groupMode}
          closeOnSelect={false}
          onSelect={setGroupMode}
          testIDPrefix="sidebar-grouping"
        />
      ),
    },
    sort: {
      label: pageLabels.sort,
      content: (
        <SingleSelectPreferenceItems
          items={sortModeItems}
          selected={sortMode}
          closeOnSelect={false}
          onSelect={setSortMode}
          testIDPrefix="sidebar-sort"
        />
      ),
    },
    "workspace-title": {
      label: pageLabels["workspace-title"],
      content: (
        <SingleSelectPreferenceItems
          items={workspaceTitleSourceItems}
          selected={workspaceTitleSource}
          closeOnSelect={false}
          onSelect={handleWorkspaceTitleSourceSelect}
          testIDPrefix="sidebar-workspace-title-source"
        />
      ),
    },
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          style={triggerStyle}
          hitSlop={platformIsWeb ? undefined : 8}
          accessibilityRole={platformIsWeb ? undefined : "button"}
          accessibilityLabel={t("sidebar.organization.trigger")}
          testID="sidebar-display-preferences-menu"
        >
          <ThemedSettings2 size={14} uniProps={filterColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          width={276}
          maxHeight={480}
          scrollable
          testID="sidebar-display-preferences-content"
        >
          {page === "root" ? (
            <>
              <DisplayPreferencePageLinks
                pages={filterPages}
                testIDPrefix="sidebar-organization-page"
                onOpen={openPage}
              />
              <DropdownMenuItem
                testID="sidebar-new-project-collection"
                onSelect={handleOpenCreateProjectCollection}
              >
                {t("sidebar.organization.actions.newProjectGroup")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={workspaceCollectionServerId === null}
                testID="sidebar-new-workspace-collection"
                onSelect={handleOpenCreateWorkspaceCollection}
              >
                {workspaceCollectionServerId
                  ? t("sidebar.organization.actions.newWorkspaceLabel")
                  : t("sidebar.organization.actions.newWorkspaceLabelSelectHost")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DisplayPreferencePageLinks
                pages={organizationPages}
                testIDPrefix="sidebar-organization-page"
                onOpen={openPage}
              />
              <DropdownMenuSeparator />
              <DisplayPreferencePageLinks
                pages={workspaceTitlePages}
                testIDPrefix="sidebar-organization-page"
                onOpen={openPage}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!isFiltered}
                onSelect={clearFilters}
                testID="sidebar-clear-filters"
              >
                {t("sidebar.organization.actions.clearFilters")}
              </DropdownMenuItem>
            </>
          ) : (
            <DisplayPreferenceSubmenu title={submenuPages[page].label} onBack={handleBack}>
              {submenuPages[page].content}
            </DisplayPreferenceSubmenu>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AdaptiveRenameModal
        visible={isCreateProjectCollectionOpen}
        title={t("sidebar.organization.projectGroup.modalTitle")}
        initialValue=""
        placeholder={t("sidebar.organization.projectGroup.placeholder")}
        submitLabel={t("sidebar.organization.actions.create")}
        onClose={handleCloseCreateProjectCollection}
        onSubmit={handleCreateProjectCollection}
        testID="sidebar-create-project-collection"
      />
      <AdaptiveRenameModal
        visible={isCreateWorkspaceCollectionOpen}
        title={t("sidebar.organization.workspaceLabel.modalTitle")}
        initialValue=""
        placeholder={t("sidebar.organization.workspaceLabel.placeholder")}
        submitLabel={t("sidebar.organization.actions.create")}
        onClose={handleCloseCreateWorkspaceCollection}
        onSubmit={handleCreateWorkspaceCollection}
        testID="sidebar-create-workspace-collection"
      />
    </>
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
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        testID="sidebar-host-filter-all"
        selected={selected.length === 0}
        selectionRole="checkbox"
        closeOnSelect={false}
        onSelect={onClear}
      >
        {t("sidebar.organization.selection.all")}
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
      selectionRole="checkbox"
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
}));
