import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Pressable, type PressableStateCallbackType, View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronLeft, Server } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import {
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
  HostPicker,
} from "@/components/hosts/host-picker";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { useHosts } from "@/runtime/host-runtime";
import { type HostProfile } from "@/types/host-connection";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function SessionsHostFilter({
  hosts,
  selectedHost,
  onSelectHost,
}: {
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
}) {
  const { theme } = useUnistyles();
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const selectedHostLabel = useMemo(
    () => getHostPickerLabel(hosts, selectedHost, { includeAllHost: true }),
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
      includeAllHost
      searchable={false}
      title="Filter by host"
      desktopPlacement="bottom-start"
    >
      <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
        <Pressable
          onPress={handleFilterOpen}
          style={filterTriggerStyle}
          testID="sessions-host-filter-trigger"
          accessibilityRole="button"
          accessibilityLabel={`Filter: ${selectedHostLabel}`}
        >
          {selectedHost === ALL_HOSTS_OPTION_ID ? (
            <Server size={14} color={theme.colors.foregroundMuted} />
          ) : (
            <HostStatusDotSlot serverId={selectedHost} />
          )}
          <Text style={styles.filterTriggerText} numberOfLines={1}>
            {selectedHostLabel}
          </Text>
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    </HostPicker>
  );
}

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
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

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [agents]);

  const emptyText =
    selectedHost === ALL_HOSTS_OPTION_ID ? t("sessions.empty") : "No sessions for this host";
  const showHostFilter = hosts.length > 1;
  const showLoadError = isError && sortedAgents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

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

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      {showHostFilter ? (
        <View style={styles.filterContainer}>
          <SessionsHostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={setSelectedHost}
          />
        </View>
      ) : null}
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
      {!isInitialLoad && !showLoadError && sortedAgents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{emptyText}</Text>
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            Back
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && sortedAgents.length > 0 ? (
        <AgentList
          agents={sortedAgents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn
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
