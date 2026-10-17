import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronLeft, Import } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { SearchField } from "@/components/ui/search-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { type AgentHistoryHostError, useAgentHistory } from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useImportSession } from "@/hooks/use-import-session";
import { useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  ALL_PROJECTS_OPTION_ID,
  buildSessionProjectOptions,
  filterAgentsByProject,
  sessionProjectKey,
  sessionProjectLabel,
} from "./sessions-screen-state";

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

function SessionsEmptyState({
  emptyText,
  isSearching,
  hasMore,
  isLoadingMore,
  onClearSearch,
  onBack,
  onImport,
  onLoadMore,
}: {
  emptyText: string;
  isSearching: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onClearSearch: () => void;
  onBack: () => void;
  onImport: () => void;
  onLoadMore: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyContainer} testID="sessions-empty">
      <Text style={styles.emptyText}>{emptyText}</Text>
      {isSearching ? (
        <Button variant="ghost" onPress={onClearSearch}>
          {t("sessions.actions.clearSearch")}
        </Button>
      ) : (
        <Button variant="ghost" leftIcon={ChevronLeft} onPress={onBack}>
          Back
        </Button>
      )}
      {hasMore ? (
        <Button variant="ghost" onPress={onLoadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
        </Button>
      ) : null}
      <Button variant="ghost" leftIcon={Import} onPress={onImport}>
        {t("importSession.title")}
      </Button>
    </View>
  );
}

function SessionProjectSelect({
  projectFilter,
  label,
  options,
  onChange,
}: {
  projectFilter: string;
  label: string;
  options: SelectFieldOption<string>[];
  onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const selectedDisplay = useMemo(
    () => (projectFilter === ALL_PROJECTS_OPTION_ID ? null : { label }),
    [projectFilter, label],
  );
  return (
    <SelectField
      label={t("sessions.projectFilter.label")}
      value={projectFilter}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={onChange}
      placeholder={t("sessions.projectFilter.all")}
      emptyText={t("sessions.projectFilter.empty")}
      title={t("sessions.projectFilter.title")}
      field={false}
      size="sm"
      testID="sessions-project-filter"
      triggerTestID="sessions-project-filter-trigger"
    />
  );
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
  projectFilter: string;
  projectLabel: string;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (input.projectFilter !== ALL_PROJECTS_OPTION_ID) {
    return input.t("sessions.projectFilter.emptyFiltered", { project: input.projectLabel });
  }
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

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const importSession = useImportSession();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const {
    agents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isSearchTruncated,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search,
  });
  const isSearching = isSearchSupported && search.length > 0;
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS_OPTION_ID);
  const projectOptions = useMemo(() => buildSessionProjectOptions(agents), [agents]);
  // Both search and the project filter narrow the already-loaded pages;
  // loading more history widens the project options.
  const visibleAgents = useMemo(
    () => filterAgentsByProject(agents, projectFilter),
    [agents, projectFilter],
  );
  const selectedProjectLabel = useMemo(
    () =>
      projectFilter === ALL_PROJECTS_OPTION_ID
        ? ""
        : (projectOptions.find((option) => option.projectKey === projectFilter)?.label ??
          sessionProjectLabel(projectFilter)),
    [projectFilter, projectOptions],
  );
  const projectFilterOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: ALL_PROJECTS_OPTION_ID,
        value: ALL_PROJECTS_OPTION_ID,
        label: t("sessions.projectFilter.all"),
        testID: "sessions-project-filter-all",
      },
      ...projectOptions.map((option) => ({
        id: option.projectKey,
        value: option.projectKey,
        label: option.label,
      })),
    ],
    [projectOptions, t],
  );
  const handleProjectPress = useCallback(
    (agent: (typeof agents)[number]) => setProjectFilter(sessionProjectKey(agent)),
    [],
  );

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

  // Searching filters the chronological history without changing its date buckets.
  const emptyText = resolveEmptyText({
    t,
    isSearching,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
    projectFilter,
    projectLabel: selectedProjectLabel,
  });
  const showHostFilter = hosts.length > 1;
  const showFilterRow = showHostFilter || isSearchSupported || projectOptions.length > 0;
  const showLoadError = isError && agents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);

  const listFooterComponent = useMemo(() => {
    // COMPAT(historyPagination): old daemons return a truncated relevance page.
    // Added in v0.8.0; remove after 2027-03-16 once the daemon floor supports search pagination.
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
          <SessionProjectSelect
            projectFilter={projectFilter}
            label={selectedProjectLabel}
            options={projectFilterOptions}
            onChange={setProjectFilter}
          />
        </View>
      ) : null}
      {hostErrors.length > 0 ? <SessionHostErrorsBanner errors={hostErrors} t={t} /> : null}
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      {!isInitialLoad && showLoadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Unable to load sessions</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            Try again
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && visibleAgents.length === 0 ? (
        <SessionsEmptyState
          emptyText={emptyText}
          isSearching={isSearching}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onClearSearch={handleClearSearch}
          onBack={handleBack}
          onImport={importSession.open}
          onLoadMore={loadMore}
        />
      ) : null}
      {!isInitialLoad && !showLoadError && visibleAgents.length > 0 ? (
        <AgentList
          agents={visibleAgents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn
          search={isSearching ? search : undefined}
          onProjectPress={handleProjectPress}
        />
      ) : null}
      {importSession.sheet}
    </View>
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
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
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
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.sm,
  },
}));
