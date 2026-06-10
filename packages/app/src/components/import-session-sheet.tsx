import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { ChevronDown, Inbox, Layers, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import { formatTimeAgo } from "@/utils/time";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectErroredProviderLabels,
  computeEmptyState,
  getPromptPreview,
  getSessionTitle,
  PER_PROVIDER_LIMIT,
  resolveProvidersToFetch,
  sumFilteredAlreadyImportedCount,
} from "@/components/import-session-sheet-view-model";

const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };

type RecentProviderSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

type ImportedAgent = Awaited<ReturnType<RecentProviderSessionsClient["importAgent"]>>;

interface ImportSessionSheetProps {
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  serverId: string | null;
  cwd?: string | null;
  onClose: () => void;
  onImportedAgent?: (agentId: string) => void;
  onImported?: (agent: ImportedAgent) => void;
}

type RecentSessionsResponse = Awaited<
  ReturnType<RecentProviderSessionsClient["fetchRecentProviderSessions"]>
>;

interface SessionsQueryConfig {
  queryKey: ReadonlyArray<string | null>;
  enabled: boolean;
  queryFn: () => Promise<RecentSessionsResponse>;
}

function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  sessionsQueryRoot: ReadonlyArray<string | null>;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  cwd: string | null | undefined;
}): SessionsQueryConfig[] {
  const { providersToFetch, sessionsQueryRoot, visible, client, cwd } = args;
  if (providersToFetch === null) return [];
  const enabled = visible && Boolean(client);
  return providersToFetch.map((provider) => ({
    queryKey: [...sessionsQueryRoot, provider],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.fetchRecentProviderSessions({
        ...(cwd ? { cwd } : {}),
        providers: [provider],
        limit: PER_PROVIDER_LIMIT,
      });
    },
  }));
}

interface SheetStatusMessagesProps {
  isClientReady: boolean;
  isSnapshotUnsupported: boolean;
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  hasRows: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importErrored: boolean;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
  hasRows,
  allQueriesErrored,
  erroredProviderLabels,
  importErrored,
}: SheetStatusMessagesProps) {
  const { theme } = useUnistyles();
  if (!isClientReady) {
    return <Text style={styles.statusText}>Connect to a host to import sessions</Text>;
  }
  if (isSnapshotUnsupported) {
    return <Text style={styles.statusText}>Update the host to import sessions.</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>No importable providers are enabled.</Text>
      ) : null}
      {isLoadingSessions && !hasRows ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>Loading recent sessions...</Text>
        </View>
      ) : null}
      {allQueriesErrored ? (
        <Text style={styles.statusText}>Could not load recent sessions.</Text>
      ) : null}
      {!allQueriesErrored && erroredProviderLabels.length > 0 ? (
        <Text style={styles.statusText}>
          Could not load sessions for {erroredProviderLabels.join(", ")}.
        </Text>
      ) : null}
      {importErrored ? (
        <Text style={styles.statusText}>Could not import selected session.</Text>
      ) : null}
    </>
  );
}

function RefreshAction({ isRefreshing, onPress }: { isRefreshing: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.refreshButton,
      pressed && styles.refreshButtonPressed,
    ],
    [],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={isRefreshing}
      accessibilityLabel="Refresh sessions"
      accessibilityRole="button"
      testID="import-session-refresh"
      style={pressableStyle}
    >
      <View style={styles.refreshIconSlot}>
        {isRefreshing ? (
          <LoadingSpinner color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={16} color={theme.colors.foregroundMuted} />
        )}
      </View>
    </Pressable>
  );
}

function SheetEmptyState({ title }: { title: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.emptyState} testID="import-session-empty-state">
      <View style={styles.emptyStateIcon}>
        <Inbox size={theme.iconSize.lg} color={theme.colors.foregroundMuted} strokeWidth={1.5} />
      </View>
      <Text style={styles.emptyStateTitle}>{title}</Text>
    </View>
  );
}

function ImportSessionSheetRow({
  entry,
  disabled,
  importing,
  showCwd,
  onImportSession,
}: {
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  showCwd: boolean;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { theme } = useUnistyles();
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const ProviderIcon = getProviderIcon(entry.providerId);
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onImportSession(entry);
  }, [entry, onImportSession]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={pressableStyle}
      testID={`import-session-session-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowMeta}>{importing ? "Importing..." : lastActivity}</Text>
        </View>
        <Text style={styles.rowPreview} numberOfLines={2}>
          {promptPreview}
        </Text>
        {showCwd && entry.cwd ? (
          <Text style={styles.rowCwd} numberOfLines={1}>
            {entry.cwd}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function ImportSessionSheet({
  visible,
  client,
  serverId,
  cwd,
  onClose,
  onImportedAgent,
  onImported,
}: ImportSessionSheetProps) {
  const queryClient = useQueryClient();
  const { theme } = useUnistyles();

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    cwd,
    enabled: visible,
  });

  const providersToFetch = useMemo(
    () => resolveProvidersToFetch(supportsSnapshot, snapshotEntries),
    [supportsSnapshot, snapshotEntries],
  );

  const providerLabelById = useMemo(
    () => buildProviderLabelMap(snapshotEntries),
    [snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(
    () => ["recent-provider-sessions", cwd ?? null] as const,
    [cwd],
  );

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        sessionsQueryRoot,
        visible,
        client,
        cwd,
      }),
    [providersToFetch, sessionsQueryRoot, visible, client, cwd],
  );

  const queries = useQueries({ queries: queriesConfig });

  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);
  const totalAlreadyImportedCount = useMemo(
    () => sumFilteredAlreadyImportedCount(queries),
    [queries],
  );

  const filterProviders = useMemo(() => [...(providersToFetch ?? [])].sort(), [providersToFetch]);

  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_FILTER_VALUE);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  useEffect(() => {
    if (
      !visible ||
      (selectedProvider !== ALL_FILTER_VALUE && !filterProviders.includes(selectedProvider))
    ) {
      setSelectedProvider(ALL_FILTER_VALUE);
    }
  }, [visible, filterProviders, selectedProvider]);

  const visibleEntries = useMemo(() => {
    if (selectedProvider === ALL_FILTER_VALUE) return aggregatedEntries;
    return aggregatedEntries.filter((entry) => entry.providerId === selectedProvider);
  }, [aggregatedEntries, selectedProvider]);

  const filterComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { id: ALL_FILTER_VALUE, label: "All providers" },
      ...filterProviders.map((provider) => ({
        id: provider,
        label: providerLabelById.get(provider) ?? provider,
      })),
    ],
    [filterProviders, providerLabelById],
  );

  const selectedProviderLabel = useMemo(
    () =>
      filterComboboxOptions.find((opt) => opt.id === selectedProvider)?.label ?? "All providers",
    [filterComboboxOptions, selectedProvider],
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

  const handleFilterSelect = useCallback((id: string) => {
    setSelectedProvider(id);
    setIsFilterOpen(false);
  }, []);

  const filterOptionIcons = useMemo(() => {
    const map = new Map<string, React.ReactNode>();
    map.set(ALL_FILTER_VALUE, <Layers size={14} color={theme.colors.foregroundMuted} />);
    for (const provider of filterProviders) {
      const ProviderIcon = getProviderIcon(provider);
      map.set(provider, <ProviderIcon size={14} color={theme.colors.foregroundMuted} />);
    }
    return map;
  }, [filterProviders, theme.colors.foregroundMuted]);

  const renderFilterOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={filterOptionIcons.get(option.id)}
      />
    ),
    [filterOptionIcons],
  );

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      if (!entry.cwd) {
        throw new Error("Session is missing a working directory");
      }
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: entry.cwd,
      });
      return agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
      onClose();
      onImportedAgent?.(agent.id);
      onImported?.(agent);
    },
  });

  const importingSessionKey =
    importMutation.isPending && importMutation.variables
      ? `${importMutation.variables.providerId}:${importMutation.variables.providerHandleId}`
      : null;

  const handleImportSession = useCallback(
    (entry: FetchRecentProviderSessionEntry) => {
      importMutation.mutate(entry);
    },
    [importMutation],
  );

  const erroredProviderLabels = useMemo(
    () => collectErroredProviderLabels(providersToFetch, queries, providerLabelById),
    [queries, providersToFetch, providerLabelById],
  );

  const isRefreshing = queries.some((query) => query.isFetching);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
  }, [queryClient, sessionsQueryRoot]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: "Import session",
      actions: <RefreshAction isRefreshing={isRefreshing} onPress={handleRefresh} />,
    }),
    [isRefreshing, handleRefresh],
  );

  const isSnapshotUnsupported = !supportsSnapshot;
  const isWaitingForSnapshot = supportsSnapshot && snapshotEntries === undefined;
  const hasNoImportableProviders = providersToFetch !== null && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders && queries.some((query) => query.isLoading || query.isPending));
  const allQueriesErrored = isQueryingProviders && queries.every((query) => query.isError);
  const allQueriesSettled =
    isQueryingProviders && queries.every((query) => !query.isLoading && !query.isPending);
  const { showEmptyState, emptyStateTitle } = computeEmptyState({
    isLoadingSessions,
    allQueriesErrored,
    isQueryingProviders,
    allQueriesSettled,
    selectedProvider,
    aggregatedCount: aggregatedEntries.length,
    visibleCount: visibleEntries.length,
    totalAlreadyImportedCount,
    providerLabelById,
  });
  const showFilter = filterProviders.length > 1;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="import-session-sheet"
      desktopMaxWidth={560}
      snapPoints={IMPORT_SHEET_SNAP_POINTS}
    >
      {showFilter ? (
        <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
          <Pressable
            onPress={handleFilterOpen}
            style={filterTriggerStyle}
            testID="import-session-filter-trigger"
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${selectedProviderLabel}`}
          >
            {selectedProvider === ALL_FILTER_VALUE ? (
              <Layers size={14} color={theme.colors.foregroundMuted} />
            ) : (
              (() => {
                const ProviderIcon = getProviderIcon(selectedProvider);
                return <ProviderIcon size={14} color={theme.colors.foregroundMuted} />;
              })()
            )}
            <Text style={styles.filterTriggerText} numberOfLines={1}>
              {selectedProviderLabel}
            </Text>
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Combobox
            options={filterComboboxOptions}
            value={selectedProvider}
            onSelect={handleFilterSelect}
            renderOption={renderFilterOption}
            searchable={false}
            title="Filter by provider"
            open={isFilterOpen}
            onOpenChange={setIsFilterOpen}
            anchorRef={filterAnchorRef}
            desktopPlacement="bottom-start"
            desktopPreventInitialFlash
          />
        </View>
      ) : null}
      <SheetStatusMessages
        isClientReady={Boolean(client)}
        isSnapshotUnsupported={isSnapshotUnsupported}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
        hasRows={visibleEntries.length > 0}
        allQueriesErrored={allQueriesErrored}
        erroredProviderLabels={erroredProviderLabels}
        importErrored={importMutation.isError}
      />
      {visibleEntries.length > 0 ? (
        <View style={styles.list}>
          {visibleEntries.map((entry) => (
            <ImportSessionSheetRow
              key={`${entry.providerId}:${entry.providerHandleId}`}
              entry={entry}
              disabled={importMutation.isPending}
              importing={importingSessionKey === `${entry.providerId}:${entry.providerHandleId}`}
              showCwd={!cwd}
              onImportSession={handleImportSession}
            />
          ))}
        </View>
      ) : null}
      {showEmptyState ? <SheetEmptyState title={emptyStateTitle} /> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  filterTriggerWrap: {
    paddingBottom: theme.spacing[2],
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
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconWrap: {
    width: theme.iconSize.md,
    paddingTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  rowCwd: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  emptyStateIcon: {
    opacity: 0.6,
    marginBottom: theme.spacing[1],
  },
  emptyStateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  refreshButton: {
    padding: theme.spacing[2],
    marginRight: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  refreshButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIconSlot: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
}));
