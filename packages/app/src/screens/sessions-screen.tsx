import { useMemo, useState, useCallback, useEffect, useRef, type ReactElement } from "react";
import { Pressable, View, Text, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronLeft, Folder } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { SearchField } from "@/components/ui/search-field";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { type AgentHistoryHostError, useAgentHistory } from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  buildSessionProjectFilterOptions,
  filterAgentsByProject,
  SESSIONS_ALL_PROJECTS_FILTER_ID,
  type SessionProjectFilterOption,
} from "@/utils/session-project-filter";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;

/**
 * A host that failed while others answered. Without this the list silently
 * under-reports, and under a query "No sessions match" becomes a claim the app
 * has no basis for.
 */
function SessionHostErrorsBanner({
  errors,
  t,
}: {
  errors: AgentHistoryHostError[];
  t: TFunction;
}): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="sessions-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("sessions.hostLoadFailed", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
  isAllProjects: boolean;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (!input.isAllProjects) return "No sessions for this project";
  if (input.isAllHosts) return input.t("sessions.empty");
  return "No sessions for this host";
}

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function useSessionsProjectFilter(historyAgents: ReturnType<typeof useAgentHistory>["agents"]) {
  const [projectFilterId, setProjectFilterId] = useState(SESSIONS_ALL_PROJECTS_FILTER_ID);
  const projectFilterOptions = useMemo(
    () => buildSessionProjectFilterOptions(historyAgents),
    [historyAgents],
  );
  const resolvedProjectFilterId = useMemo(() => {
    if (projectFilterId === SESSIONS_ALL_PROJECTS_FILTER_ID) {
      return SESSIONS_ALL_PROJECTS_FILTER_ID;
    }
    if (projectFilterOptions.some((option) => option.id === projectFilterId)) {
      return projectFilterId;
    }
    return SESSIONS_ALL_PROJECTS_FILTER_ID;
  }, [projectFilterId, projectFilterOptions]);
  const agents = useMemo(
    () => filterAgentsByProject(historyAgents, resolvedProjectFilterId),
    [historyAgents, resolvedProjectFilterId],
  );
  return {
    agents,
    projectFilterOptions,
    resolvedProjectFilterId,
    setProjectFilterId,
  };
}

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const {
    agents: historyAgents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isSearchTruncated,
    searchMatchesByAgentKey,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search,
  });
  const isSearching = isSearchSupported && search.length > 0;
  const { agents, projectFilterOptions, resolvedProjectFilterId, setProjectFilterId } =
    useSessionsProjectFilter(historyAgents);

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  // `useAgentHistory` owns the order: recency at rest, relevance under a query.
  const emptyText = resolveEmptyText({
    t,
    isSearching,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
    isAllProjects: resolvedProjectFilterId === SESSIONS_ALL_PROJECTS_FILTER_ID,
  });
  const showHostFilter = hosts.length > 1;
  const showProjectFilter = projectFilterOptions.length > 0;
  const showFilterRow = showHostFilter || showProjectFilter || isSearchSupported;
  const showLoadError = isError && agents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);

  const listFooterComponent = useMemo(() => {
    // A ranked result set has no next page — reaching a weaker match means
    // narrowing the query, so the footer says that instead of offering a button.
    if (isSearchTruncated) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerHint}>{t("sessions.tooManyMatches")}</Text>
        </View>
      );
    }
    if (!hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
        </Button>
      </View>
    );
  }, [hasMore, isLoadingMore, isSearchTruncated, loadMore, t]);

  const body = (() => {
    if (isInitialLoad) {
      return (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      );
    }
    if (showLoadError) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Unable to load sessions</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            Try again
          </Button>
        </View>
      );
    }
    if (agents.length === 0) {
      return (
        <View style={styles.emptyContainer} testID="sessions-empty">
          <Text style={styles.emptyText}>{emptyText}</Text>
          {isSearching ? (
            <Button variant="ghost" onPress={handleClearSearch}>
              {t("sessions.actions.clearSearch")}
            </Button>
          ) : (
            <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
              Back
            </Button>
          )}
        </View>
      );
    }
    return (
      <AgentList
        agents={agents}
        showCheckoutInfo={false}
        isRefreshing={isManualRefresh}
        onRefresh={handleRefresh}
        listFooterComponent={listFooterComponent}
        showAttentionIndicator={false}
        showHostColumn
        searchMatchesByAgentKey={isSearching ? searchMatchesByAgentKey : undefined}
        flat={isSearching}
      />
    );
  })();

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      {showFilterRow ? (
        <View style={styles.filterContainer}>
          {isSearchSupported ? (
            <SearchField
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder={t("sessions.searchPlaceholder")}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              testID="sessions-search-input"
              clearTestID="sessions-search-clear"
            />
          ) : null}
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={setSelectedHost}
              triggerTestID="sessions-host-filter-trigger"
              hostOptionTestID={sessionsHostOptionTestID}
            />
          ) : null}
          {showProjectFilter ? (
            <SessionsProjectFilter
              options={projectFilterOptions}
              value={resolvedProjectFilterId}
              onSelect={setProjectFilterId}
            />
          ) : null}
        </View>
      ) : null}
      {hostErrors.length > 0 ? <SessionHostErrorsBanner errors={hostErrors} t={t} /> : null}
      {body}
    </View>
  );
}

function SessionsProjectFilter({
  options,
  value,
  onSelect,
}: {
  options: readonly SessionProjectFilterOption[];
  value: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View | null>(null);
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { id: SESSIONS_ALL_PROJECTS_FILTER_ID, label: "All projects" },
      ...options.map((option) => ({ id: option.id, label: option.label })),
    ],
    [options],
  );
  const selectedLabel =
    value === SESSIONS_ALL_PROJECTS_FILTER_ID
      ? "All projects"
      : (options.find((option) => option.id === value)?.label ?? "All projects");
  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.projectFilterTrigger,
      (Boolean(hovered) || pressed || open) && styles.projectFilterTriggerActive,
    ],
    [open],
  );
  const handlePress = useCallback(() => {
    setOpen((current) => !current);
  }, []);
  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={styles.projectFilterWrap}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Filter by project: ${selectedLabel}`}
          testID="sessions-project-filter-trigger"
        >
          <Folder size={14} color={styles.projectFilterIcon.color} />
          <Text style={styles.projectFilterTriggerText} numberOfLines={1}>
            {selectedLabel}
          </Text>
          <ChevronDown size={14} color={styles.projectFilterIcon.color} />
        </Pressable>
      </View>
      <Combobox
        options={comboboxOptions}
        value={value}
        onSelect={handleSelect}
        searchable={options.length > 6}
        searchPlaceholder="Search projects..."
        emptyText="No projects found"
        title="Filter by project"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterContainer: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  projectFilterWrap: {
    flexShrink: 1,
    minWidth: 0,
  },
  projectFilterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    maxWidth: 220,
  },
  projectFilterTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  projectFilterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  projectFilterIcon: {
    color: theme.colors.foregroundMuted,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBannerWrap: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
  },
  errorsBanner: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
