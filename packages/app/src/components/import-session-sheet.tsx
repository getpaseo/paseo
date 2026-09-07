import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { keepPreviousData, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { ChevronDown, Inbox, Layers, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import { formatTimeAgo } from "@/utils/time";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostProjects } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { i18n } from "@/i18n/i18next";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectProviderErrorRows,
  computeEmptyState,
  type DirectoryProject,
  formatDirectoryLabel,
  getPromptPreview,
  getSessionTitle,
  hasMoreSessions,
  resolveDirectoryLabel,
  nextPageLimit,
  PER_PROVIDER_LIMIT,
  type ProviderErrorRow,
  resolveImportTarget,
  resolveProvidersToFetch,
  requiresImportSessionsHostUpgrade,
  sumFilteredAlreadyImportedCount,
} from "@/components/import-session-sheet-view-model";

const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };
/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

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
  workspaceId?: string | null;
  onClose: () => void;
  /** The agent belongs to the workspace the sheet was opened from; open it here. */
  onImportedAgent?: (agentId: string) => void;
  /** The agent belongs to its own workspace; open that workspace and navigate. */
  onImported?: (agent: ImportedAgent) => void;
}

type RecentSessionsResponse = Awaited<
  ReturnType<RecentProviderSessionsClient["fetchRecentProviderSessions"]>
>;

type SessionsQueryKey = ReadonlyArray<string | number | null>;

function buildSessionsQueryKey(input: {
  cwd: string | null;
  query: string;
  limit: number;
  provider?: string;
}): SessionsQueryKey {
  return [
    "recent-provider-sessions",
    input.cwd,
    input.query,
    input.limit,
    ...(input.provider === undefined ? [] : [input.provider]),
  ];
}

interface SessionsQueryConfig {
  queryKey: SessionsQueryKey;
  enabled: boolean;
  // A provider that cannot answer stays broken until the user asks again. React
  // Query's default retry would keep the header spinner turning and pile up
  // in-flight daemon requests behind a dead provider (#2512).
  retry: false;
  placeholderData: typeof keepPreviousData;
  queryFn: () => Promise<RecentSessionsResponse>;
}

function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  cwd: string | null;
  query: string;
  limit: number;
  hostDisconnectedMessage?: string;
}): SessionsQueryConfig[] {
  const { providersToFetch, visible, client, cwd, query, limit, hostDisconnectedMessage } = args;
  if (providersToFetch === null) return [];
  const enabled = visible && Boolean(client);
  return providersToFetch.map((provider) => ({
    queryKey: buildSessionsQueryKey({ cwd, query, limit, provider }),
    enabled,
    retry: false as const,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (!client) {
        throw new Error(hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
      }
      return await client.fetchRecentProviderSessions({
        ...(cwd ? { cwd } : {}),
        providers: [provider],
        limit,
        ...(query ? { query } : {}),
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
  importErrored: boolean;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
  hasRows,
  importErrored,
}: SheetStatusMessagesProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  if (!isClientReady) {
    return <Text style={styles.statusText}>{t("importSession.status.connectHost")}</Text>;
  }
  if (isSnapshotUnsupported) {
    return <Text style={styles.statusText}>{t("importSession.status.updateHost")}</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>{t("importSession.status.noProviders")}</Text>
      ) : null}
      {isLoadingSessions && !hasRows ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>{t("importSession.status.loading")}</Text>
        </View>
      ) : null}
      {importErrored ? (
        <Text style={styles.statusText}>{t("importSession.status.failedImport")}</Text>
      ) : null}
    </>
  );
}

function ProviderErrorBanner({
  rows,
  onRetry,
}: {
  rows: ReadonlyArray<ProviderErrorRow>;
  onRetry: (provider: string) => void;
}) {
  return (
    <View style={styles.errorBanner} testID="import-session-provider-errors">
      {rows.map((row) => (
        <ProviderErrorBannerRow key={row.provider} row={row} onRetry={onRetry} />
      ))}
    </View>
  );
}

function ProviderErrorBannerRow({
  row,
  onRetry,
}: {
  row: ProviderErrorRow;
  onRetry: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => onRetry(row.provider), [onRetry, row.provider]);
  return (
    <View style={styles.errorRow}>
      <Text style={styles.errorText}>
        {t("importSession.status.failedProvider", { provider: row.label })}
      </Text>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleRetry}
        testID={`import-session-retry-${row.provider}`}
      >
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

function RefreshAction({ isRefreshing, onPress }: { isRefreshing: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
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
      accessibilityLabel={t("importSession.actions.refresh")}
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

function ScopeSubtitle({
  hostLabel,
  isScoped,
  onShowAll,
}: {
  hostLabel: string;
  isScoped: boolean;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.subtitleRow}>
      <Text style={styles.subtitleText} numberOfLines={1} testID="import-session-scope">
        {isScoped
          ? t("importSession.scope.workspace")
          : t("importSession.scope.host", { host: hostLabel })}
      </Text>
      {isScoped ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={onShowAll}
          testID="import-session-show-all"
          style={styles.subtitleAction}
        >
          {t("importSession.actions.showAll")}
        </Button>
      ) : null}
    </View>
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
  serverId,
  entry,
  disabled,
  importing,
  folder,
  onImportSession,
}: {
  serverId: string | null;
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  /** The row's directory, shown only when rows can come from more than one. */
  folder: string | null;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const ProviderIcon = getProviderIcon(entry.providerId, serverId);
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
          <Text style={styles.rowMeta}>
            {importing ? t("importSession.row.importing") : lastActivity}
          </Text>
        </View>
        <Text style={styles.rowPreview} numberOfLines={2}>
          {promptPreview}
        </Text>
        {folder ? (
          <Text
            style={styles.rowFolder}
            numberOfLines={1}
            testID={`import-session-row-folder-${entry.providerId}-${entry.providerHandleId}`}
          >
            {folder}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function SessionRows({
  serverId,
  entries,
  disabled,
  importingSessionKey,
  resolveFolder,
  onImportSession,
}: {
  serverId: string | null;
  entries: ReadonlyArray<FetchRecentProviderSessionEntry>;
  disabled: boolean;
  importingSessionKey: string | null;
  resolveFolder: (entry: FetchRecentProviderSessionEntry) => string | null;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  return (
    <View style={styles.list}>
      {entries.map((entry) => (
        <ImportSessionSheetRow
          key={`${entry.providerId}:${entry.providerHandleId}`}
          serverId={serverId}
          entry={entry}
          disabled={disabled}
          importing={importingSessionKey === `${entry.providerId}:${entry.providerHandleId}`}
          folder={resolveFolder(entry)}
          onImportSession={onImportSession}
        />
      ))}
    </View>
  );
}

export function ImportSessionSheet({
  visible,
  client,
  serverId,
  cwd,
  workspaceId,
  onClose,
  onImportedAgent,
  onImported,
}: ImportSessionSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { theme } = useUnistyles();

  // "Show all" widens a workspace-scoped sheet to the whole host. The sheet's own
  // `cwd` stays the scope it was opened with, because that is what decides where
  // an imported agent lands.
  const [isShowingAllDirectories, setIsShowingAllDirectories] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [pageLimit, setPageLimit] = useState(PER_PROVIDER_LIMIT);
  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_FILTER_VALUE);

  const scopeCwd = isShowingAllDirectories ? null : (cwd ?? null);
  const supportsSearch = useHostFeature(serverId, "importSessionSearch");
  const query = useDebouncedValue(supportsSearch ? searchInput : "", SEARCH_DEBOUNCE_MS).trim();

  useEffect(() => {
    if (visible) return;
    setIsShowingAllDirectories(false);
    setSearchInput("");
  }, [visible]);

  // A narrower or wider list starts at page one; keeping a grown limit would
  // fetch 200 rows for a query that matches three.
  useEffect(() => {
    setPageLimit(PER_PROVIDER_LIMIT);
  }, [query, scopeCwd]);

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    cwd: scopeCwd,
    enabled: visible,
  });
  const supportsWorkspaceTarget = useHostFeature(serverId, "importSessionWorkspaceTarget");
  const requiresHostUpgrade = requiresImportSessionsHostUpgrade({
    supportsSnapshot,
    workspaceId,
    supportsWorkspaceTarget,
  });

  const providersToFetch = useMemo(
    () => (requiresHostUpgrade ? null : resolveProvidersToFetch(supportsSnapshot, snapshotEntries)),
    [requiresHostUpgrade, supportsSnapshot, snapshotEntries],
  );

  const providerLabelById = useMemo(
    () => buildProviderLabelMap(snapshotEntries),
    [snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(() => ["recent-provider-sessions", scopeCwd], [scopeCwd]);

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        visible,
        client,
        cwd: scopeCwd,
        query,
        limit: pageLimit,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [providersToFetch, visible, client, scopeCwd, query, pageLimit, t],
  );

  const queries = useQueries({ queries: queriesConfig });

  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);
  const totalAlreadyImportedCount = useMemo(
    () => sumFilteredAlreadyImportedCount(queries),
    [queries],
  );

  const filterProviders = useMemo(() => [...(providersToFetch ?? [])].sort(), [providersToFetch]);
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

  const projectServerIds = useMemo(() => (serverId ? [serverId] : []), [serverId]);
  const hostProjects = useHostProjects(projectServerIds);
  const directoryProjects = useMemo<DirectoryProject[]>(
    () =>
      hostProjects.map((project) => ({
        rootPath: project.iconWorkingDir,
        name: project.projectName,
      })),
    [hostProjects],
  );

  // A scoped sheet only lists one directory, so naming it on every row is noise.
  const showRowFolders = scopeCwd === null;
  const resolveFolder = useCallback(
    (entry: FetchRecentProviderSessionEntry) =>
      showRowFolders
        ? formatDirectoryLabel(resolveDirectoryLabel(entry.cwd, directoryProjects))
        : null,
    [showRowFolders, directoryProjects],
  );

  const filterComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { id: ALL_FILTER_VALUE, label: t("importSession.filters.all") },
      ...filterProviders.map((provider) => ({
        id: provider,
        label: providerLabelById.get(provider) ?? provider,
      })),
    ],
    [filterProviders, providerLabelById, t],
  );

  const selectedProviderLabel = useMemo(
    () =>
      filterComboboxOptions.find((opt) => opt.id === selectedProvider)?.label ??
      t("importSession.filters.all"),
    [filterComboboxOptions, selectedProvider, t],
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
      const ProviderIcon = getProviderIcon(provider, serverId);
      map.set(provider, <ProviderIcon size={14} color={theme.colors.foregroundMuted} />);
    }
    return map;
  }, [filterProviders, serverId, theme.colors.foregroundMuted]);

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
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (!entry.cwd) {
        throw new Error("Session is missing a working directory");
      }
      const target = resolveImportTarget({
        entryCwd: entry.cwd,
        workspaceCwd: cwd,
        workspaceId,
        isScopedListing: scopeCwd !== null,
      });
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: entry.cwd,
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      });
      return { agent, target };
    },
    onSuccess: ({ agent, target }) => {
      onClose();
      if (target.crossWorkspace) {
        onImported?.(agent);
      } else {
        onImportedAgent?.(agent.id);
      }
      void queryClient.invalidateQueries({
        queryKey: sessionsQueryRoot,
        refetchType: "none",
      });
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

  const providerErrorRows = useMemo(
    () => collectProviderErrorRows(providersToFetch, queries, providerLabelById),
    [queries, providersToFetch, providerLabelById],
  );

  // Every query settles, errors included, so this stops turning (#2512).
  const isRefreshing = queries.some((providerQuery) => providerQuery.isFetching);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
  }, [queryClient, sessionsQueryRoot]);

  const handleRetryProvider = useCallback(
    (provider: string) => {
      void queryClient.refetchQueries({
        queryKey: buildSessionsQueryKey({ cwd: scopeCwd, query, limit: pageLimit, provider }),
      });
    },
    [pageLimit, query, queryClient, scopeCwd],
  );

  const handleShowAll = useCallback(() => setIsShowingAllDirectories(true), []);
  const handleLoadMore = useCallback(() => setPageLimit(nextPageLimit), []);

  const hosts = useHosts();
  const hostLabel = useMemo(
    () => hosts.find((host) => host.serverId === serverId)?.label ?? serverId ?? "",
    [hosts, serverId],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("importSession.title"),
      subtitle: (
        <ScopeSubtitle
          hostLabel={hostLabel}
          isScoped={scopeCwd !== null}
          onShowAll={handleShowAll}
        />
      ),
      ...(supportsSearch
        ? {
            search: {
              onChange: setSearchInput,
              placeholder: t("importSession.searchPlaceholder"),
              // The compact sheet keeps its content mounted while hidden, so the
              // field has to be told to drop the text the state already dropped.
              resetKey: visible ? "open" : "closed",
              testID: "import-session-search",
            },
          }
        : {}),
      actions: <RefreshAction isRefreshing={isRefreshing} onPress={handleRefresh} />,
    }),
    [handleRefresh, handleShowAll, hostLabel, isRefreshing, scopeCwd, supportsSearch, t, visible],
  );

  const isSnapshotUnsupported = requiresHostUpgrade;
  const isWaitingForSnapshot = supportsSnapshot && snapshotEntries === undefined;
  const hasNoImportableProviders = providersToFetch !== null && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders &&
      queries.some((providerQuery) => providerQuery.isLoading || providerQuery.isPending));
  const allQueriesErrored =
    isQueryingProviders && queries.every((providerQuery) => providerQuery.isError);
  const allQueriesSettled =
    isQueryingProviders &&
    queries.every((providerQuery) => !providerQuery.isLoading && !providerQuery.isPending);
  const { showEmptyState, emptyStateTitle } = computeEmptyState({
    isLoadingSessions,
    allQueriesErrored,
    isQueryingProviders,
    allQueriesSettled,
    selectedProvider,
    hasQuery: query.length > 0,
    aggregatedCount: aggregatedEntries.length,
    visibleCount: visibleEntries.length,
    totalAlreadyImportedCount,
    providerLabelById,
  });
  const showFilter = filterProviders.length > 1;
  const showLoadMore = hasMoreSessions(queries, pageLimit);

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
                const ProviderIcon = getProviderIcon(selectedProvider, serverId);
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
        importErrored={importMutation.isError}
      />
      {providerErrorRows.length > 0 ? (
        <ProviderErrorBanner rows={providerErrorRows} onRetry={handleRetryProvider} />
      ) : null}
      {visibleEntries.length > 0 ? (
        <SessionRows
          serverId={serverId}
          entries={visibleEntries}
          disabled={importMutation.isPending}
          importingSessionKey={importingSessionKey}
          resolveFolder={resolveFolder}
          onImportSession={handleImportSession}
        />
      ) : null}
      {showLoadMore ? (
        <View style={styles.footer}>
          <Button
            variant="ghost"
            onPress={handleLoadMore}
            disabled={isRefreshing}
            testID="import-session-load-more"
          >
            {t("importSession.actions.loadMore")}
          </Button>
        </View>
      ) : null}
      {showEmptyState ? <SheetEmptyState title={emptyStateTitle} /> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  subtitleText: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  subtitleAction: {
    marginHorizontal: -theme.spacing[2],
  },
  filterTriggerWrap: {
    paddingBottom: theme.spacing[2],
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    maxWidth: "100%",
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
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  list: {
    gap: theme.spacing[1],
  },
  footer: {
    paddingTop: theme.spacing[2],
    alignItems: "center",
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
    fontSize: theme.fontSize.sm,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  rowFolder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorBanner: {
    marginBottom: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  errorText: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.palette.red[300],
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
