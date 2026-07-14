import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { type PressableStateCallbackType } from "react-native";
import { Settings2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
import type { HostProfile } from "@/types/host-connection";
import type { Theme } from "@/styles/theme";
import { isWeb as platformIsWeb } from "@/constants/platform";
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
type SubmenuPage = Exclude<MenuPage, "main">;

interface HistorySubmenuDescriptor {
  label: string;
  content: ReactElement;
}

const ThemedSettings2 = withUnistyles(Settings2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function selectedCountLabel(
  keys: readonly string[],
  labels: ReadonlyMap<string, string>,
  t: TFunction,
): string {
  if (keys.length === 0) return t("sessions.organization.selection.all");
  if (keys.length === 1) {
    return labels.get(keys[0] ?? "") ?? t("sessions.organization.selection.oneSelected");
  }
  return t("sessions.organization.selection.selectedCount", { count: keys.length });
}

export function HistoryDisplayPreferencesMenu({
  hosts,
  projects,
}: {
  hosts: readonly HostProfile[];
  projects: readonly HistoryProjectOption[];
}) {
  const { t } = useTranslation();
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
  const hasUnavailableHistoryOrganizationHost = selectedServerIds.some(
    (serverId) => historyOrganizationAvailability.get(serverId) !== "supported",
  );
  const baseStatusOptions = useMemo<Array<DisplayPreferenceOption<HistoryStatusFilter>>>(
    () => [
      { value: "active", label: t("sessions.organization.status.active") },
      { value: "archived", label: t("sessions.organization.status.archived") },
      { value: "all", label: t("sessions.organization.selection.all") },
    ],
    [t],
  );
  const baseActivityOptions = useMemo<Array<DisplayPreferenceOption<HistoryLastActivityFilter>>>(
    () => [
      { value: "any", label: t("sessions.organization.activity.anyTime") },
      { value: "today", label: t("sessions.organization.activity.today") },
      { value: "7d", label: t("sessions.organization.activity.pastSevenDays") },
      { value: "30d", label: t("sessions.organization.activity.pastThirtyDays") },
    ],
    [t],
  );
  const groupOptions = useMemo<Array<DisplayPreferenceOption<HistoryGroupMode>>>(
    () => [
      { value: "last_activity", label: t("sessions.organization.group.lastActivity") },
      { value: "project", label: t("sessions.organization.group.project") },
      { value: "none", label: t("sessions.organization.group.none") },
    ],
    [t],
  );
  const sortOptions = useMemo<Array<DisplayPreferenceOption<HistorySortMode>>>(
    () => [
      { value: "alphabetical", label: t("sessions.organization.sort.alphabetical") },
      { value: "created", label: t("sessions.organization.sort.createdTime") },
      { value: "recency", label: t("sessions.organization.sort.recency") },
    ],
    [t],
  );
  const statusOptions = useMemo(
    () =>
      baseStatusOptions.map((option) => ({
        ...option,
        label:
          option.value === "archived" && hasUnavailableHistoryOrganizationHost
            ? t("sessions.organization.updateHost", { label: option.label })
            : option.label,
        disabled: option.value === "archived" && hasUnavailableHistoryOrganizationHost,
      })),
    [baseStatusOptions, hasUnavailableHistoryOrganizationHost, t],
  );
  const activityOptions = useMemo(
    () =>
      baseActivityOptions.map((option) => ({
        ...option,
        label:
          option.value !== "any" && hasUnavailableHistoryOrganizationHost
            ? t("sessions.organization.updateHost", { label: option.label })
            : option.label,
        disabled: option.value !== "any" && hasUnavailableHistoryOrganizationHost,
      })),
    [baseActivityOptions, hasUnavailableHistoryOrganizationHost, t],
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
  const handleOpenPage = useCallback((nextPage: SubmenuPage) => setPage(nextPage), []);
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
  const filterPages = useMemo<DisplayPreferencePage<SubmenuPage>[]>(
    () => [
      {
        page: "status",
        label: t("sessions.organization.labels.status"),
        value: displayPreferenceOptionLabel(
          baseStatusOptions,
          status,
          t("sessions.organization.selection.all"),
        ),
      },
      {
        page: "project",
        label: t("sessions.organization.labels.project"),
        value: selectedCountLabel(projectFilters, projectLabels, t),
      },
      {
        page: "host",
        label: t("sessions.organization.labels.host"),
        value: selectedCountLabel(hostFilters, hostLabels, t),
      },
      {
        page: "activity",
        label: t("sessions.organization.labels.lastActivity"),
        value: displayPreferenceOptionLabel(
          baseActivityOptions,
          lastActivity,
          t("sessions.organization.activity.anyTime"),
        ),
      },
    ],
    [
      baseActivityOptions,
      baseStatusOptions,
      hostFilters,
      hostLabels,
      lastActivity,
      projectFilters,
      projectLabels,
      status,
      t,
    ],
  );
  const organizationPages = useMemo<DisplayPreferencePage<SubmenuPage>[]>(
    () => [
      {
        page: "group",
        label: t("sessions.organization.labels.groupBy"),
        value: displayPreferenceOptionLabel(
          groupOptions,
          groupMode,
          t("sessions.organization.group.lastActivity"),
        ),
      },
      {
        page: "sort",
        label: t("sessions.organization.labels.sortBy"),
        value: displayPreferenceOptionLabel(
          sortOptions,
          sortMode,
          t("sessions.organization.sort.recency"),
        ),
      },
    ],
    [groupMode, groupOptions, sortMode, sortOptions, t],
  );

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );
  const submenuPages: Record<SubmenuPage, HistorySubmenuDescriptor> = {
    status: {
      label: t("sessions.organization.labels.status"),
      content: <StatusItems options={statusOptions} />,
    },
    project: {
      label: t("sessions.organization.labels.project"),
      content: <ProjectItems projects={projects} />,
    },
    host: {
      label: t("sessions.organization.labels.host"),
      content: <HostItems hosts={hosts} />,
    },
    activity: {
      label: t("sessions.organization.labels.lastActivity"),
      content: <ActivityItems options={activityOptions} />,
    },
    group: {
      label: t("sessions.organization.labels.groupBy"),
      content: <GroupItems options={groupOptions} />,
    },
    sort: {
      label: t("sessions.organization.labels.sortBy"),
      content: <SortItems options={sortOptions} />,
    },
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        style={triggerStyle}
        hitSlop={platformIsWeb ? undefined : 6}
        accessibilityRole="button"
        accessibilityLabel={t("sessions.organization.trigger")}
        testID="history-display-preferences-trigger"
      >
        <ThemedSettings2 size={16} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={280}
        maxHeight={480}
        scrollable
        testID="history-display-preferences-menu"
      >
        {page === "main" ? (
          <>
            <DisplayPreferencePageLinks pages={filterPages} onOpen={handleOpenPage} />
            <DropdownMenuSeparator />
            <DisplayPreferencePageLinks pages={organizationPages} onOpen={handleOpenPage} />
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!hasFilters} onSelect={clearFilters}>
              {t("sessions.organization.clearFilters")}
            </DropdownMenuItem>
          </>
        ) : (
          <DisplayPreferenceSubmenu title={submenuPages[page].label} onBack={handleBack}>
            {submenuPages[page].content}
          </DisplayPreferenceSubmenu>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusItems({
  options,
}: {
  options: ReadonlyArray<DisplayPreferenceOption<HistoryStatusFilter>>;
}) {
  const selected = useHistoryViewStore((state) => state.status);
  const setStatus = useHistoryViewStore((state) => state.setStatus);
  return <SingleSelectPreferenceItems items={options} selected={selected} onSelect={setStatus} />;
}

function ActivityItems({
  options,
}: {
  options: ReadonlyArray<DisplayPreferenceOption<HistoryLastActivityFilter>>;
}) {
  const selected = useHistoryViewStore((state) => state.lastActivity);
  const setLastActivity = useHistoryViewStore((state) => state.setLastActivity);
  return (
    <SingleSelectPreferenceItems items={options} selected={selected} onSelect={setLastActivity} />
  );
}

function GroupItems({
  options,
}: {
  options: ReadonlyArray<DisplayPreferenceOption<HistoryGroupMode>>;
}) {
  const selected = useHistoryViewStore((state) => state.groupMode);
  const setGroupMode = useHistoryViewStore((state) => state.setGroupMode);
  return (
    <SingleSelectPreferenceItems items={options} selected={selected} onSelect={setGroupMode} />
  );
}

function SortItems({
  options,
}: {
  options: ReadonlyArray<DisplayPreferenceOption<HistorySortMode>>;
}) {
  const selected = useHistoryViewStore((state) => state.sortMode);
  const setSortMode = useHistoryViewStore((state) => state.setSortMode);
  return <SingleSelectPreferenceItems items={options} selected={selected} onSelect={setSortMode} />;
}

function ProjectItems({ projects }: { projects: readonly HistoryProjectOption[] }) {
  const { t } = useTranslation();
  const selected = useHistoryViewStore((state) => state.projectFilters);
  const toggle = useHistoryViewStore((state) => state.toggleProjectFilter);
  const clear = useHistoryViewStore((state) => state.clearProjectFilters);
  const items = useMemo(
    () => projects.map((project) => ({ value: project.projectKey, label: project.projectName })),
    [projects],
  );
  return (
    <MultiSelectPreferenceItems
      allLabel={t("sessions.organization.selection.all")}
      items={items}
      selected={selected}
      onClear={clear}
      onToggle={toggle}
    />
  );
}

function HostItems({ hosts }: { hosts: readonly HostProfile[] }) {
  const { t } = useTranslation();
  const selected = useHistoryViewStore((state) => state.hostFilters);
  const toggle = useHistoryViewStore((state) => state.toggleHostFilter);
  const clear = useHistoryViewStore((state) => state.clearHostFilters);
  const items = useMemo(
    () =>
      hosts.map((host) => ({
        value: host.serverId,
        label: host.label?.trim() || host.serverId,
      })),
    [hosts],
  );
  return (
    <MultiSelectPreferenceItems
      allLabel={t("sessions.organization.selection.all")}
      items={items}
      selected={selected}
      onClear={clear}
      onToggle={toggle}
    />
  );
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
}));
