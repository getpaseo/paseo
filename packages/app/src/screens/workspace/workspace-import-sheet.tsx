import React, { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, FetchRecentProviderSessionEntry } from "@server/client/daemon-client";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { formatTimeAgo } from "@/utils/time";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

const IMPORTABLE_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const PER_PROVIDER_LIMIT = 15;
const FALLBACK_LIMIT = 20;
const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const activityIndicatorColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

type RecentProviderSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

interface WorkspaceImportSheetProps {
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  serverId: string | null;
  workspaceDirectory: string | null;
  onClose: () => void;
  onImportedAgent: (agentId: string) => void;
}

type ProvidersToFetch = AgentProvider[] | "fallback" | "loading";

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
): ProvidersToFetch {
  if (!supportsSnapshot) return "fallback";
  if (!snapshotEntries) return "loading";
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
  providersToFetch: ProvidersToFetch;
  sessionsQueryRoot: ReadonlyArray<string | null>;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  workspaceDirectory: string | null;
}): SessionsQueryConfig[] {
  const { providersToFetch, sessionsQueryRoot, visible, client, workspaceDirectory } = args;
  const enabled = visible && Boolean(client && workspaceDirectory);
  if (providersToFetch === "loading") return [];
  if (providersToFetch === "fallback") {
    return [
      {
        queryKey: [...sessionsQueryRoot, "__all__"],
        enabled,
        queryFn: async () => {
          if (!client || !workspaceDirectory) {
            throw new Error("Host is not connected");
          }
          return await client.fetchRecentProviderSessions({
            cwd: workspaceDirectory,
            limit: FALLBACK_LIMIT,
          });
        },
      },
    ];
  }
  return providersToFetch.map((provider) => ({
    queryKey: [...sessionsQueryRoot, provider],
    enabled,
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      return await client.fetchRecentProviderSessions({
        cwd: workspaceDirectory,
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

function collectErroredProviderLabels(
  providersToFetch: ProvidersToFetch,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): string[] {
  if (providersToFetch === "loading" || providersToFetch === "fallback") return [];
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
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importErrored: boolean;
  showEmptyState: boolean;
}

function SheetStatusMessages({
  isClientReady,
  hasNoImportableProviders,
  isLoadingSessions,
  allQueriesErrored,
  erroredProviderLabels,
  importErrored,
  showEmptyState,
}: SheetStatusMessagesProps) {
  if (!isClientReady) {
    return <Text style={styles.statusText}>Connect to a workspace to import agents.</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>No importable providers are enabled.</Text>
      ) : null}
      {isLoadingSessions ? (
        <View style={styles.statusRow}>
          <ThemedActivityIndicator size="small" uniProps={activityIndicatorColorMapping} />
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
      {showEmptyState ? <Text style={styles.statusText}>No recent sessions to import.</Text> : null}
    </>
  );
}

function WorkspaceImportSheetRow({
  entry,
  disabled,
  importing,
  onImportSession,
}: {
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onImportSession(entry);
  }, [entry, onImportSession]);

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={styles.row}
      testID={`workspace-import-session-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.providerLabel} numberOfLines={1}>
          {entry.providerLabel}
        </Text>
        <Text style={styles.lastActivity}>{lastActivity}</Text>
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.promptPreview} numberOfLines={2}>
        {promptPreview}
      </Text>
      {importing ? <Text style={styles.importingText}>Importing...</Text> : null}
    </Pressable>
  );
}

export function WorkspaceImportSheet({
  visible,
  client,
  serverId,
  workspaceDirectory,
  onClose,
  onImportedAgent,
}: WorkspaceImportSheetProps) {
  const queryClient = useQueryClient();

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
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
    () => ["recent-provider-sessions", workspaceDirectory] as const,
    [workspaceDirectory],
  );

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        sessionsQueryRoot,
        visible,
        client,
        workspaceDirectory,
      }),
    [providersToFetch, sessionsQueryRoot, visible, client, workspaceDirectory],
  );

  const queries = useQueries({ queries: queriesConfig });

  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: workspaceDirectory,
      });
      return agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
      onClose();
      onImportedAgent(agent.id);
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

  const isWaitingForSnapshot = providersToFetch === "loading";
  const hasNoImportableProviders = Array.isArray(providersToFetch) && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders && queries.some((query) => query.isLoading || query.isPending));
  const allQueriesErrored = isQueryingProviders && queries.every((query) => query.isError);
  const allQueriesSettled =
    isQueryingProviders && queries.every((query) => !query.isLoading && !query.isPending);
  const showEmptyState =
    !isLoadingSessions &&
    !allQueriesErrored &&
    isQueryingProviders &&
    allQueriesSettled &&
    aggregatedEntries.length === 0;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title="Import agent"
      testID="workspace-import-sheet"
      desktopMaxWidth={560}
      snapPoints={IMPORT_SHEET_SNAP_POINTS}
    >
      <SheetStatusMessages
        isClientReady={Boolean(client && workspaceDirectory)}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
        allQueriesErrored={allQueriesErrored}
        erroredProviderLabels={erroredProviderLabels}
        importErrored={importMutation.isError}
        showEmptyState={showEmptyState}
      />
      {aggregatedEntries.length > 0 ? (
        <View style={styles.list}>
          {aggregatedEntries.map((entry) => (
            <WorkspaceImportSheetRow
              key={`${entry.providerId}:${entry.providerHandleId}`}
              entry={entry}
              disabled={importMutation.isPending}
              importing={importingSessionKey === `${entry.providerId}:${entry.providerHandleId}`}
              onImportSession={handleImportSession}
            />
          ))}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  rowHeader: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  providerLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  lastActivity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  promptPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
  },
  importingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
