import { useMemo, useState, useCallback, useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { HistoryDisplayPreferencesMenu } from "@/components/history-display-preferences-menu";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { buildHistorySections, buildHistoryServerQuery } from "@/hooks/history-view-model";
import { useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useHostProjects } from "@/projects/host-projects";
import { useHistoryViewStore } from "@/stores/history-view-store";
import { useSessionStore } from "@/stores/session-store";
import { subscribeToPersistHydration } from "@/stores/persist-hydration";
import { resolveHistoryFilterReconciliation } from "@/screens/history-filter-reconciliation";
import { buildOpenProjectRoute } from "@/utils/host-routes";

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
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const status = useHistoryViewStore((state) => state.status);
  const projectFilters = useHistoryViewStore((state) => state.projectFilters);
  const hostFilters = useHistoryViewStore((state) => state.hostFilters);
  const lastActivity = useHistoryViewStore((state) => state.lastActivity);
  const groupMode = useHistoryViewStore((state) => state.groupMode);
  const sortMode = useHistoryViewStore((state) => state.sortMode);
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const projects = useHostProjects(hostIds);
  const hydratedServerIds = useSessionStore(
    useShallow((state) =>
      hostIds.filter((serverId) => state.sessions[serverId]?.hasHydratedWorkspaces ?? false),
    ),
  );
  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        projectKey: project.projectKey,
        projectName: project.projectName,
      })),
    [projects],
  );
  const selectedServerIds = hostFilters.length > 0 ? hostFilters : hostIds;
  const serverQuery = useMemo(
    () =>
      buildHistoryServerQuery({
        status,
        projectFilters,
        lastActivity,
        sortMode,
        now: new Date(),
      }),
    [lastActivity, projectFilters, sortMode, status],
  );
  const { agents, hasMore, isInitialLoad, isLoadingMore, isError, loadMore, refreshAll } =
    useAgentHistory({
      serverIds: selectedServerIds,
      query: serverQuery,
      sortMode,
    });

  const [hasHydratedHistoryPreferences, setHasHydratedHistoryPreferences] = useState(() =>
    useHistoryViewStore.persist.hasHydrated(),
  );
  useEffect(
    () =>
      subscribeToPersistHydration(useHistoryViewStore.persist, () => {
        setHasHydratedHistoryPreferences(true);
      }),
    [],
  );
  useEffect(() => {
    const reconciliation = resolveHistoryFilterReconciliation({
      preferencesHydrated: hasHydratedHistoryPreferences,
      hostRegistryLoaded,
      allServerIds: hostIds,
      hydratedServerIds,
      allHostProjects: projects,
    });
    if (!reconciliation) return;
    const store = useHistoryViewStore.getState();
    store.reconcileHostFilters(reconciliation.hostKeys);
    if (reconciliation.projectKeys !== null) {
      store.reconcileProjectFilters(reconciliation.projectKeys);
    }
  }, [hasHydratedHistoryPreferences, hostIds, hostRegistryLoaded, hydratedServerIds, projects]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const sections = useMemo(
    () => buildHistorySections({ agents, groupMode, now: new Date() }),
    [agents, groupMode],
  );
  const hasFilters =
    status !== "all" ||
    projectFilters.length > 0 ||
    hostFilters.length > 0 ||
    lastActivity !== "any";
  const emptyText = hasFilters ? t("sessions.organization.emptyFiltered") : t("sessions.empty");
  const showLoadError = isError && agents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const listFooterComponent = useMemo(
    () =>
      hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? t("common.loading") : t("sessions.actions.loadMore")}
          </Button>
        </View>
      ) : null,
    [hasMore, loadMore, isLoadingMore, t],
  );
  const headerRightContent = useMemo(
    () => <HistoryDisplayPreferencesMenu hosts={hosts} projects={projectOptions} />,
    [hosts, projectOptions],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} rightContent={headerRightContent} />
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      {!isInitialLoad && showLoadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{t("sessions.errors.loadFailed")}</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && agents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{emptyText}</Text>
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            Back
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && agents.length > 0 ? (
        <AgentList
          sections={sections}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn={selectedServerIds.length > 1}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
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
}));
