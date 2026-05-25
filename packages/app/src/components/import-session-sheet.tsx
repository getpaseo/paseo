import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, FetchRecentProviderSessionEntry } from "@server/client/daemon-client";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import { IMPORTABLE_PROVIDERS } from "@server/shared/importable-providers";
import { Inbox, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { getProviderIcon } from "@/components/provider-icons";
import { formatTimeAgo } from "@/utils/time";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

const IMPORTABLE_PROVIDER_IDS: Set<string> = new Set(IMPORTABLE_PROVIDERS);
const PER_PROVIDER_LIMIT = 15;
const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };
const ALL_FILTER_VALUE = "__all__";

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

interface SessionsQueryResult {
  data: RecentSessionsResponse | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
}

function resolveProvidersToFetch(
  supportsSnapshot: boolean,
  snapshotEntries: ReadonlyArray<{ provider: string; enabled?: boolean }> | undefined,
): AgentProvider[] | null {
  // COMPAT(providersSnapshot): the import-recent-sessions feature ships alongside
  // providersSnapshot (v0.1.48, 2026-04-05). Daemons older than that lack both —
  // we render an "update host" empty state instead of degrading. Drop this gate
  // when the supported daemon floor is >= v0.1.48 (target: 2026-10-05).
  if (!supportsSnapshot) return null;
  if (!snapshotEntries) return null;
  return snapshotEntries
    .filter((entry) => IMPORTABLE_PROVIDER_IDS.has(entry.provider) && entry.enabled !== false)
    .map((entry) => entry.provider);
}

function buildProviderLabelMap(
  snapshotEntries: ReadonlyArray<{ provider: string; label?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!snapshotEntries) return map;
  for (const entry of snapshotEntries) {
    if (entry.label) {
      map.set(entry.provider, entry.label);
    }
  }
  return map;
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

function aggregateSessionEntries(
  queries: ReadonlyArray<SessionsQueryResult>,
): FetchRecentProviderSessionEntry[] {
  const seen = new Set<string>();
  const collected: FetchRecentProviderSessionEntry[] = [];
  for (const query of queries) {
    if (!query.data) continue;
    for (const entry of query.data.entries) {
      const key = `${entry.providerId}:${entry.providerHandleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  collected.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  return collected;
}

function sumFilteredAlreadyImportedCount(queries: ReadonlyArray<SessionsQueryResult>): number {
  let total = 0;
  for (const query of queries) {
    total += query.data?.filteredAlreadyImportedCount ?? 0;
  }
  return total;
}

function collectErroredProviderLabels(
  providersToFetch: AgentProvider[] | null,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): string[] {
  if (providersToFetch === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < queries.length; index++) {
    if (queries[index]?.isError) {
      const provider = providersToFetch[index];
      labels.push(providerLabelById.get(provider) ?? provider);
    }
  }
  return labels;
}

function getSessionTitle(entry: FetchRecentProviderSessionEntry): string {
  const title = entry.title?.trim();
  if (title) {
    return title;
  }
  const firstPromptPreview = entry.firstPromptPreview?.trim();
  if (firstPromptPreview) {
    return firstPromptPreview;
  }
  return "Untitled session";
}

function getPromptPreview(entry: FetchRecentProviderSessionEntry): string {
  return entry.lastPromptPreview?.trim() || entry.firstPromptPreview?.trim() || "No prompt preview";
}

interface SheetStatusMessagesProps {
  isClientReady: boolean;
  isSnapshotUnsupported: boolean;
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importErrored: boolean;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
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
      {isLoadingSessions ? (
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

interface EmptyStateInputs {
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  isQueryingProviders: boolean;
  allQueriesSettled: boolean;
  selectedProvider: string;
  aggregatedCount: number;
  visibleCount: number;
  totalAlreadyImportedCount: number;
  providerLabelById: ReadonlyMap<string, string>;
}

function computeEmptyState(input: EmptyStateInputs): {
  showEmptyState: boolean;
  emptyStateTitle: string;
} {
  const showEmptyState =
    !input.isLoadingSessions &&
    !input.allQueriesErrored &&
    input.isQueryingProviders &&
    input.allQueriesSettled &&
    input.visibleCount === 0;
  if (!showEmptyState) {
    return { showEmptyState, emptyStateTitle: "" };
  }
  const isFilteredEmpty = input.selectedProvider !== ALL_FILTER_VALUE && input.aggregatedCount > 0;
  if (isFilteredEmpty) {
    const label = input.providerLabelById.get(input.selectedProvider) ?? input.selectedProvider;
    return { showEmptyState, emptyStateTitle: `No ${label} sessions found.` };
  }
  if (input.totalAlreadyImportedCount > 0) {
    return { showEmptyState, emptyStateTitle: "All recent sessions are already imported." };
  }
  return { showEmptyState, emptyStateTitle: "No recent sessions to import." };
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

function buildProviderFilterOptions(
  providers: ReadonlyArray<string>,
  providerLabelById: ReadonlyMap<string, string>,
): SegmentedControlOption<string>[] {
  const options: SegmentedControlOption<string>[] = [
    { value: ALL_FILTER_VALUE, label: "All", testID: "import-session-filter-all" },
  ];
  for (const provider of providers) {
    const ProviderIcon = getProviderIcon(provider);
    options.push({
      value: provider,
      label: providerLabelById.get(provider) ?? provider,
      testID: `import-session-filter-${provider}`,
      icon: ({ color, size }) => <ProviderIcon color={color} size={size} />,
    });
  }
  return options;
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

  const filterOptions = useMemo(
    () => buildProviderFilterOptions(filterProviders, providerLabelById),
    [filterProviders, providerLabelById],
  );

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const effectiveCwd = cwd ?? entry.cwd;
      if (!effectiveCwd) {
        throw new Error("Session is missing a working directory");
      }
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: effectiveCwd,
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
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <SegmentedControl
            testID="import-session-filters"
            size="sm"
            options={filterOptions}
            value={selectedProvider}
            onValueChange={setSelectedProvider}
          />
        </ScrollView>
      ) : null}
      <SheetStatusMessages
        isClientReady={Boolean(client)}
        isSnapshotUnsupported={isSnapshotUnsupported}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
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
  filterRow: {
    flexDirection: "row",
    paddingBottom: theme.spacing[2],
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
