import { useMemo, useState, useCallback, useEffect } from "react";
import { View, Text, type StyleProp, type ViewStyle } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { selectAllArchivedAgentKeys } from "@/components/agent-list-selection";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { useAgentHistory } from "@/hooks/use-agent-history";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useDeleteAgent } from "@/hooks/use-delete-agent";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  areAllArchivedAgentsSelected,
  deleteSelectedArchivedAgents,
  syncSelectedKeysToAgents,
  toggleAgentSelectionKey,
} from "./sessions-manage";

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
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const { deleteAgent } = useDeleteAgent();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [isManaging, setIsManaging] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const { agents, hasMore, isInitialLoad, isLoadingMore, isError, loadMore, refreshAll } =
    useAgentHistory({
      serverId: historyServerId,
    });

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [agents]);

  const archivedKeys = useMemo(() => selectAllArchivedAgentKeys(sortedAgents), [sortedAgents]);

  useEffect(() => {
    setSelectedKeys((current) => syncSelectedKeysToAgents(current, sortedAgents));
  }, [sortedAgents]);

  useEffect(() => {
    setIsManaging(false);
    setSelectedKeys(new Set());
  }, [selectedHost]);

  const emptyText =
    selectedHost === ALL_HOSTS_OPTION_ID ? t("sessions.empty") : "No sessions for this host";
  const showHostFilter = hosts.length > 1;
  const showLoadError = !isInitialLoad && isError && sortedAgents.length === 0;
  const canManage = archivedKeys.size > 0;
  const selectedCount = selectedKeys.size;
  const allArchivedSelected = areAllArchivedAgentsSelected(sortedAgents, selectedKeys);

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleExitManage = useCallback(() => {
    setIsManaging(false);
    setSelectedKeys(new Set());
  }, []);

  const handleEnterManage = useCallback(() => {
    setIsManaging(true);
  }, []);

  const handleToggleSelect = useCallback((agent: AggregatedAgent) => {
    setSelectedKeys((current) => toggleAgentSelectionKey(current, agent));
  }, []);

  const handleSelectAllArchived = useCallback(() => {
    setSelectedKeys(selectAllArchivedAgentKeys(sortedAgents));
  }, [sortedAgents]);

  const handleClearSelection = useCallback(() => {
    setSelectedKeys(new Set());
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedKeys.size === 0 || isDeleting) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: t("sessions.manage.deleteConfirmTitle", { count: selectedKeys.size }),
        message: t("sessions.manage.deleteConfirmMessage", { count: selectedKeys.size }),
        confirmLabel: t("sessions.manage.delete"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      setIsDeleting(true);
      try {
        await deleteSelectedArchivedAgents({
          agents: sortedAgents,
          selectedKeys,
          deleteAgent,
        });
        handleExitManage();
      } finally {
        setIsDeleting(false);
      }
    })();
  }, [deleteAgent, handleExitManage, isDeleting, selectedKeys, sortedAgents, t]);

  const listFooterComponent = useMemo(
    () =>
      hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
          </Button>
        </View>
      ) : null,
    [hasMore, loadMore, isLoadingMore, t],
  );

  const manageHeaderAction = useMemo(() => {
    if (!canManage && !isManaging) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        size="sm"
        onPress={isManaging ? handleExitManage : handleEnterManage}
        testID="sessions-manage-toggle"
      >
        {isManaging ? t("sessions.manage.done") : t("sessions.manage.manage")}
      </Button>
    );
  }, [canManage, handleEnterManage, handleExitManage, isManaging, t]);

  const manageBarStyle = useMemo(
    () => [styles.manageBar, { paddingBottom: Math.max(insets.bottom, theme.spacing[3]) }],
    [insets.bottom, theme.spacing],
  );

  const showList = !isInitialLoad && !isError && sortedAgents.length > 0;
  const showEmpty = !isInitialLoad && !isError && sortedAgents.length === 0;

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} rightContent={manageHeaderAction} />
      {showHostFilter ? (
        <View style={styles.filterContainer}>
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={setSelectedHost}
            triggerTestID="sessions-host-filter-trigger"
          />
        </View>
      ) : null}
      {isManaging ? <Text style={styles.manageHint}>{t("sessions.manage.hint")}</Text> : null}
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      {showLoadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Unable to load sessions</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            Try again
          </Button>
        </View>
      ) : null}
      {showEmpty ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{emptyText}</Text>
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            Back
          </Button>
        </View>
      ) : null}
      {showList ? (
        <AgentList
          agents={sortedAgents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn
          selectionMode={isManaging}
          selectedKeys={selectedKeys}
          onToggleSelect={handleToggleSelect}
        />
      ) : null}
      {isManaging ? (
        <HistoryManageBar
          style={manageBarStyle}
          allArchivedSelected={allArchivedSelected}
          archivedCount={archivedKeys.size}
          selectedCount={selectedCount}
          isDeleting={isDeleting}
          onSelectAll={handleSelectAllArchived}
          onClearSelection={handleClearSelection}
          onDeleteSelected={handleDeleteSelected}
        />
      ) : null}
    </View>
  );
}

function HistoryManageBar({
  style,
  allArchivedSelected,
  archivedCount,
  selectedCount,
  isDeleting,
  onSelectAll,
  onClearSelection,
  onDeleteSelected,
}: {
  style: StyleProp<ViewStyle>;
  allArchivedSelected: boolean;
  archivedCount: number;
  selectedCount: number;
  isDeleting: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}) {
  const { t } = useTranslation();
  let selectAllLabel = t("sessions.manage.selectAll");
  if (allArchivedSelected) {
    selectAllLabel = t("sessions.manage.invertSelection");
  }
  let deleteLabel = t("sessions.manage.deleteSelected", { count: selectedCount });
  if (isDeleting) {
    deleteLabel = t("sessions.manage.deleting");
  }

  return (
    <View style={style}>
      <Button
        variant="ghost"
        size="sm"
        onPress={allArchivedSelected ? onClearSelection : onSelectAll}
        disabled={archivedCount === 0 || isDeleting}
        testID="sessions-manage-select-all"
      >
        {selectAllLabel}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onPress={onDeleteSelected}
        disabled={selectedCount === 0 || isDeleting}
        testID="sessions-manage-delete"
      >
        {deleteLabel}
      </Button>
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
  manageHint: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  manageBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
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
