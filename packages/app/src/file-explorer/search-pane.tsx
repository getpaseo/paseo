import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { TreeChevron } from "@/components/tree-primitives";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import {
  buildFileSearchRows,
  createInitialFileSearchState,
  DEFAULT_FILE_SEARCH_OPTIONS,
  fileSearchReducer,
  filterCollapsedFileSearchRows,
  splitFileSearchMatchContent,
  type FileSearchOptions,
  type FileSearchRow,
  type FileSearchState,
} from "./search-model";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX_RESULTS = 2000;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface FileSearchPaneProps {
  client: DaemonClient | null;
  workspaceRoot: string;
  onOpenMatch: (path: string, line: number) => void;
}

export function FileSearchPane({
  client,
  workspaceRoot,
  onOpenMatch,
}: FileSearchPaneProps): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FileSearchOptions>(DEFAULT_FILE_SEARCH_OPTIONS);
  const [state, dispatch] = useReducer(fileSearchReducer, undefined, createInitialFileSearchState);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const requestKeyRef = useRef(0);

  useEffect(() => {
    requestKeyRef.current += 1;
    const requestKey = requestKeyRef.current;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      dispatch({ type: "reset" });
      return;
    }

    dispatch({ type: "start", requestKey });
    const timer = setTimeout(() => {
      if (!client) {
        dispatch({ type: "error", requestKey, error: t("workspace.terminal.hostDisconnected") });
        return;
      }
      void client
        .searchFiles({
          cwd: workspaceRoot,
          query: trimmedQuery,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          useRegex: options.useRegex,
          includePattern: normalizePattern(options.includePattern),
          excludePattern: normalizePattern(options.excludePattern),
          maxResults: SEARCH_MAX_RESULTS,
        })
        .then((result) => dispatch({ type: "success", requestKey, result }))
        .catch((error: unknown) => {
          dispatch({
            type: "error",
            requestKey,
            error: error instanceof Error ? error.message : "Search failed",
          });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    client,
    options.caseSensitive,
    options.excludePattern,
    options.includePattern,
    options.useRegex,
    options.wholeWord,
    query,
    t,
    workspaceRoot,
  ]);

  const allRows = useMemo(
    () => (state.status === "success" ? buildFileSearchRows(state.result) : []),
    [state],
  );
  const rows = useMemo(
    () => filterCollapsedFileSearchRows(allRows, collapsedPaths),
    [allRows, collapsedPaths],
  );
  const toggleFile = useCallback((path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const updateOption = useCallback(
    <TKey extends keyof FileSearchOptions>(key: TKey, value: FileSearchOptions[TKey]) => {
      setOptions((current) => ({ ...current, [key]: value }));
    },
    [],
  );
  const toggleCase = useCallback(
    () => updateOption("caseSensitive", !options.caseSensitive),
    [options.caseSensitive, updateOption],
  );
  const toggleWord = useCallback(
    () => updateOption("wholeWord", !options.wholeWord),
    [options.wholeWord, updateOption],
  );
  const toggleRegex = useCallback(
    () => updateOption("useRegex", !options.useRegex),
    [options.useRegex, updateOption],
  );
  const updateIncludePattern = useCallback(
    (value: string) => updateOption("includePattern", value),
    [updateOption],
  );
  const updateExcludePattern = useCallback(
    (value: string) => updateOption("excludePattern", value),
    [updateOption],
  );
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<FileSearchRow>) => (
      <FileSearchResultRow
        row={item}
        collapsed={item.kind === "file" && collapsedPaths.has(item.path)}
        onToggleFile={toggleFile}
        onOpenMatch={onOpenMatch}
      />
    ),
    [collapsedPaths, onOpenMatch, toggleFile],
  );

  return (
    <View style={styles.container} testID="file-search-pane">
      <View style={styles.searchHeader}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("common.placeholders.search")}
          clearAccessibilityLabel={t("common.actions.close")}
          autoFocus
          testID="files-search-input"
          clearTestID="files-search-clear"
        />
      </View>
      <View style={styles.optionsRow}>
        <SearchOptionButton
          label="Aa"
          accessibilityLabel="Match case"
          selected={options.caseSensitive === true}
          onPress={toggleCase}
          testID="files-search-case"
        />
        <SearchOptionButton
          label="W"
          accessibilityLabel="Match whole word"
          selected={options.wholeWord === true}
          onPress={toggleWord}
          testID="files-search-word"
        />
        <SearchOptionButton
          label=".*"
          accessibilityLabel="Use regular expression"
          selected={options.useRegex === true}
          onPress={toggleRegex}
          testID="files-search-regex"
        />
        <ThemedTextInput
          value={options.includePattern ?? ""}
          onChangeText={updateIncludePattern}
          placeholder="Include: *.ts"
          accessibilityLabel="Files to include"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.patternInput}
          testID="files-search-include"
        />
        <ThemedTextInput
          value={options.excludePattern ?? ""}
          onChangeText={updateExcludePattern}
          placeholder="Exclude: *.test.ts"
          accessibilityLabel="Files to exclude"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.patternInput}
          testID="files-search-exclude"
        />
      </View>
      <FileSearchStateContent state={state} rows={rows} renderRow={renderRow} />
    </View>
  );
}

function normalizePattern(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function SearchOptionButton({
  label,
  accessibilityLabel,
  selected,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const optionStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionButton,
      selected && styles.optionButtonSelected,
      (Boolean(hovered) || pressed) && styles.optionButtonHovered,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      style={optionStyle}
      testID={testID}
    >
      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

function FileSearchStateContent({
  state,
  rows,
  renderRow,
}: {
  state: FileSearchState;
  rows: FileSearchRow[];
  renderRow: (info: ListRenderItemInfo<FileSearchRow>) => ReactElement;
}) {
  const { t } = useTranslation();
  if (state.status === "idle") {
    return <SearchStateLabel label={t("common.actions.search")} />;
  }
  if (state.status === "loading") {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.stateText}>{t("common.states.loading")}</Text>
      </View>
    );
  }
  if (state.status === "error") {
    return <SearchStateLabel label={state.error} error />;
  }
  if (rows.length === 0) {
    return <SearchStateLabel label={t("common.empty.noResults")} />;
  }
  return (
    <View style={styles.resultsContainer}>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>
          {state.result.totalMatches} · {state.result.files.length}
        </Text>
        {state.result.truncated ? (
          <Text style={styles.truncatedText}>Results truncated</Text>
        ) : null}
      </View>
      <FlatList
        data={rows}
        renderItem={renderRow}
        keyExtractor={fileSearchRowKey}
        keyboardShouldPersistTaps="handled"
        style={styles.resultsList}
        contentContainerStyle={styles.resultsContent}
        testID="files-search-results"
      />
    </View>
  );
}

function SearchStateLabel({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <View style={styles.centerState}>
      <Text style={error ? styles.errorText : styles.stateText}>{label}</Text>
    </View>
  );
}

function fileSearchRowKey(row: FileSearchRow): string {
  return row.key;
}

function FileSearchResultRow({
  row,
  collapsed,
  onToggleFile,
  onOpenMatch,
}: {
  row: FileSearchRow;
  collapsed: boolean;
  onToggleFile: (path: string) => void;
  onOpenMatch: (path: string, line: number) => void;
}) {
  if (row.kind === "file") {
    return <FileSearchFileRow row={row} collapsed={collapsed} onToggleFile={onToggleFile} />;
  }
  return <FileSearchMatchRow row={row} onOpenMatch={onOpenMatch} />;
}

function FileSearchFileRow({
  row,
  collapsed,
  onToggleFile,
}: {
  row: Extract<FileSearchRow, { kind: "file" }>;
  collapsed: boolean;
  onToggleFile: (path: string) => void;
}) {
  const handlePress = useCallback(() => onToggleFile(row.path), [onToggleFile, row.path]);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  return (
    <Pressable
      onPress={handlePress}
      style={fileRowStyle}
      accessibilityRole="button"
      accessibilityLabel={row.path}
      accessibilityState={accessibilityState}
      testID={`files-search-file-${row.path}`}
    >
      <TreeChevron expanded={!collapsed} />
      <MaterialFileIcon fileName={row.path} size={ICON_SIZE.sm} />
      <Text numberOfLines={1} style={styles.filePath}>
        {row.path}
      </Text>
      <Text style={styles.matchCount}>{row.matchCount}</Text>
    </Pressable>
  );
}

function fileRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.fileRow, (Boolean(hovered) || pressed) && styles.fileRowHovered];
}

function FileSearchMatchRow({
  row,
  onOpenMatch,
}: {
  row: Extract<FileSearchRow, { kind: "match" }>;
  onOpenMatch: (path: string, line: number) => void;
}) {
  const handlePress = useCallback(
    () => onOpenMatch(row.path, row.match.line),
    [onOpenMatch, row.match.line, row.path],
  );
  const content = splitFileSearchMatchContent(row.match);
  return (
    <Pressable
      onPress={handlePress}
      style={matchRowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${row.path}, line ${row.match.line}`}
      testID={`files-search-match-${row.key}`}
    >
      <Text style={styles.lineNumber}>{row.match.line}</Text>
      <Text numberOfLines={1} style={styles.lineContent}>
        {content.prefix}
        <Text style={styles.matchHighlight}>{content.match}</Text>
        {content.suffix}
      </Text>
    </Pressable>
  );
}

function matchRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.matchRow, (Boolean(hovered) || pressed) && styles.matchRowHovered];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  searchHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  optionButton: {
    height: 26,
    minWidth: 26,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  optionButtonSelected: {
    backgroundColor: theme.colors.surface3,
  },
  optionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  optionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  optionLabelSelected: {
    color: theme.colors.foreground,
  },
  patternInput: {
    flex: 1,
    minWidth: 0,
    height: 26,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    outlineWidth: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  resultsContainer: {
    flex: 1,
    minHeight: 0,
  },
  summaryRow: {
    minHeight: 26,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
  },
  summaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  truncatedText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
  },
  resultsList: {
    flex: 1,
    minHeight: 0,
  },
  resultsContent: {
    paddingBottom: theme.spacing[4],
  },
  fileRow: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  fileRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  filePath: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  matchCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  matchRow: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
  },
  matchRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  lineNumber: {
    width: 32,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    textAlign: "right",
  },
  lineContent: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  matchHighlight: {
    color: theme.colors.accentBright,
    backgroundColor: theme.colors.surface3,
  },
}));
