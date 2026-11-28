import { useCallback, useRef, type ReactElement } from "react";
import { FlatList, Text, View, type ListRenderItemInfo } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useOverlayFlatListScrollbar } from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import { useFetchQuery } from "@/data/query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { resolveFileFilterView, type FileFilterMatch, type FileFilterResponse } from "./model";

const SEARCH_DEBOUNCE_MS = 100;
const SEARCH_LIMIT = 100;
export const FILE_FILTER_QUERY_KEY = "fileExplorerFilter";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function matchKey(match: FileFilterMatch): string {
  return `${match.kind}:${match.path}`;
}

/** The Files list while a filter is typed: matches from anywhere in the workspace. */
export function FileFilterResults({
  serverId,
  workspaceRoot,
  query,
  showHiddenFiles,
  isCompact,
  renderMatch,
}: {
  serverId: string;
  workspaceRoot: string;
  query: string;
  showHiddenFiles: boolean;
  isCompact: boolean;
  renderMatch: (match: FileFilterMatch, index: number) => ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useFetchQuery({
    queryKey: [FILE_FILTER_QUERY_KEY, serverId, workspaceRoot, debouncedQuery],
    queryFn: async (): Promise<FileFilterResponse> => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.getDirectorySuggestions({
        cwd: workspaceRoot,
        query: debouncedQuery,
        includeFiles: true,
        includeDirectories: true,
        limit: SEARCH_LIMIT,
      });
      if (payload.error) throw new Error(payload.error);
      return { query: debouncedQuery, entries: payload.entries };
    },
    dataShape: "list",
    staleTimeMs: 0,
    retry: false,
  });
  const view = resolveFileFilterView({
    query,
    response: search.data,
    error: search.error && debouncedQuery === query ? toErrorMessage(search.error) : null,
    isFetching: search.isFetching,
    showHiddenFiles,
  });

  const listRef = useRef<FlatList<FileFilterMatch>>(null);
  const scrollbar = useOverlayFlatListScrollbar(listRef, { enabled: !isCompact });
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<FileFilterMatch>) => renderMatch(item, index),
    [renderMatch],
  );
  const { refetch } = search;
  const handleRetry = useCallback(() => void refetch(), [refetch]);

  if (view.status === "results") {
    return (
      <View style={styles.fill}>
        <FlatList
          ref={listRef}
          style={styles.fill}
          contentContainerStyle={styles.content}
          data={view.matches}
          renderItem={renderItem}
          keyExtractor={matchKey}
          keyboardShouldPersistTaps="handled"
          testID="file-filter-results"
          onLayout={scrollbar.onLayout}
          onScroll={scrollbar.onScroll}
          onContentSizeChange={scrollbar.onContentSizeChange}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={!scrollbar.enabled}
        />
        {scrollbar.overlay}
      </View>
    );
  }

  return (
    <View style={styles.state}>
      {view.status === "loading" ? (
        <>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.stateText}>{t("workspace.fileExplorer.filter.loading")}</Text>
        </>
      ) : null}
      {view.status === "empty" ? (
        <Text style={styles.stateText}>{t("workspace.fileExplorer.filter.empty")}</Text>
      ) : null}
      {view.status === "error" ? (
        <>
          <Text style={styles.errorText}>{view.message}</Text>
          <Button variant="outline" size="sm" onPress={handleRetry}>
            {t("workspace.fileExplorer.actions.retry")}
          </Button>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    paddingTop: theme.spacing[2],
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
