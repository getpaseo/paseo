import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceContentMatch } from "@getpaseo/protocol/messages";
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { createWorkspaceFileTabTarget } from "@/workspace/file-open";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { WorkspaceFileSource } from "@/file-pane/source";
import { formatFileSize } from "@/utils/format-file-size";
import { describeWorkspaceFilePath } from "../workspace-file-search-model";
import {
  WorkspaceContentSearchModel,
  type ContentSearchSnapshot,
  type ContentSearchTransport,
} from "./internal/model";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface Props {
  /** The Command Center owns the field; this body only reacts to what was typed in it. */
  query: string;
  compact: boolean;
  close(): void;
  clearScope(): void;
  keyHandler: React.RefObject<((key: string) => boolean) | null>;
}

export function WorkspaceContentSearch(props: Props) {
  const { keyHandler, close, clearScope } = props;
  const { t } = useTranslation();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const session = useSessionStore((state) => (serverId ? state.sessions[serverId] : undefined));
  const unavailable =
    !session?.client ||
    !cwd ||
    !serverId ||
    !workspaceId ||
    !session.serverInfo?.features?.workspaceContentSearch;
  useEffect(() => {
    if (!unavailable) return;
    keyHandler.current = (key) => {
      if (key === "Escape") close();
      else if (key === "Backspace") clearScope();
      return ["Enter", "ArrowUp", "ArrowDown", "Escape", "Backspace"].includes(key);
    };
    return () => {
      keyHandler.current = null;
    };
  }, [unavailable, keyHandler, close, clearScope]);
  if (!session?.client || !cwd || !serverId || !workspaceId)
    return <Text style={styles.status}>{t("shell.commandCenter.contentUnavailable")}</Text>;
  // COMPAT(workspaceContentSearch): added in v0.8.0, remove after 2027-03-09 once daemon floor >= v0.8.0.
  if (!session.serverInfo?.features?.workspaceContentSearch)
    return <Text style={styles.status}>{t("shell.commandCenter.contentUpdateHost")}</Text>;
  return (
    <ContentSearch
      key={`${serverId}:${workspaceId}`}
      {...props}
      transport={session.client}
      cwd={cwd}
      serverId={serverId}
      workspaceId={workspaceId}
    />
  );
}

function ContentSearch({
  transport,
  cwd,
  serverId,
  workspaceId,
  query,
  compact,
  close,
  clearScope,
  keyHandler,
}: Props & {
  transport: ContentSearchTransport;
  cwd: string;
  serverId: string;
  workspaceId: string;
}) {
  const [previewPage, setPreviewPage] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const model = useMemo(
    () =>
      new WorkspaceContentSearchModel({
        cwd,
        transport,
        open(location) {
          clearCommandCenterFocusRestoreElement();
          const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
          if (!workspaceKey) return;
          const layout = useWorkspaceLayoutStore.getState();
          const tabId = layout.openTab({
            workspaceKey,
            target: createWorkspaceFileTabTarget(location),
            intent: "reveal",
          });
          if (tabId) layout.focusTab(workspaceKey, tabId);
          usePanelStore.getState().showMobileAgent();
          closeRef.current();
        },
      }),
    [cwd, transport, serverId, workspaceId],
  );
  useEffect(() => () => model.dispose(), [model]);
  // The field lives in the Command Center header, so the typed value is a prop; this is the only
  // bridge from it into the model that owns the search.
  useEffect(() => {
    setPreviewPage(false);
    model.setQuery(query);
  }, [model, query]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const listRef = useRef<FlatList>(null);
  useEffect(() => {
    if (state.matches.length && (!compact || !previewPage))
      listRef.current?.scrollToIndex({
        index: state.activeIndex,
        animated: false,
        viewPosition: 0.5,
      });
  }, [compact, previewPage, state.activeIndex, state.matches]);
  const key = useCallback(
    (pressed: string) => {
      if (pressed === "Escape") {
        close();
        return true;
      }
      if (pressed === "Backspace" && !state.query) {
        clearScope();
        return true;
      }
      if (pressed === "ArrowDown" || pressed === "ArrowUp") {
        model.move(pressed === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (pressed === "Enter") {
        model.openSelected();
        return true;
      }
      return false;
    },
    [close, clearScope, model, state.query],
  );
  useEffect(() => {
    keyHandler.current = key;
    return () => {
      if (keyHandler.current === key) keyHandler.current = null;
    };
  }, [keyHandler, key]);
  const select = useCallback(
    (index: number) => {
      model.select(index);
      if (compact) setPreviewPage(true);
    },
    [model, compact],
  );
  const back = useCallback(() => setPreviewPage(false), []);
  const renderItem = useCallback(
    ({ item, index }: { item: WorkspaceContentMatch; index: number }) => (
      <ResultRow item={item} index={index} selected={state.activeIndex === index} select={select} />
    ),
    [select, state.activeIndex],
  );
  const emptyState = useMemo(
    () => <SearchState state={state} retry={model.retry} />,
    [model.retry, state],
  );
  const limitNotice = useMemo(() => <ResultLimit limited={state.limited} />, [state.limited]);
  return (
    <View style={styles.body}>
      {!compact || !previewPage ? (
        <View style={[styles.results, compact && styles.full]}>
          <FlatList
            ref={listRef}
            data={state.matches}
            keyboardShouldPersistTaps="handled"
            keyExtractor={resultKey}
            getItemLayout={resultLayout}
            renderItem={renderItem}
            ListEmptyComponent={emptyState}
            ListFooterComponent={limitNotice}
          />
        </View>
      ) : null}
      {!compact || previewPage ? (
        <ContentPreview state={state} model={model} compact={compact} back={back} />
      ) : null}
    </View>
  );
}

function ResultRow({
  item,
  index,
  selected,
  select,
}: {
  item: WorkspaceContentMatch;
  index: number;
  selected: boolean;
  select(index: number): void;
}) {
  const onPress = useCallback(() => select(index), [index, select]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  // Same hover/selection idiom as the Command Center's own result rows, one tint apart so the
  // keyboard cursor that drives the preview stays distinguishable from the pointer.
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && styles.hovered,
      selected && styles.selected,
    ],
    [selected],
  );
  const line = useMemo(() => describeMatchLine(item), [item]);
  const file = useMemo(() => describeWorkspaceFilePath(item.path), [item.path]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.path}:${item.line}:${item.columnStart} ${item.snippet}`}
      accessibilityState={accessibilityState}
      aria-pressed={isWeb ? selected : undefined}
      onPress={onPress}
      style={style}
    >
      <Text style={styles.snippet} numberOfLines={1}>
        {line.before}
        <Text style={styles.match}>{line.match}</Text>
        {line.after}
      </Text>
      <Text style={styles.location} numberOfLines={1}>
        <Text style={styles.locationFile}>
          {file.name}:{item.line}:{item.columnStart}
        </Text>
        {file.directory ? <Text style={styles.locationDirectory}> {file.directory}</Text> : null}
      </Text>
    </Pressable>
  );
}

/** The row is one line wide, so the match has to survive indentation and long-line offsets. */
function describeMatchLine(item: WorkspaceContentMatch) {
  // Only a run-up long enough to be worth cutting is cut, so an ordinary line keeps its start.
  const cut = item.snippetMatchStart > SNIPPET_LEAD * 2;
  const from = cut ? item.snippetMatchStart - SNIPPET_LEAD : 0;
  const before = item.snippet.slice(from, item.snippetMatchStart);
  return {
    before: cut ? `…${before}` : before.trimStart(),
    match: item.snippet.slice(item.snippetMatchStart, item.snippetMatchEnd),
    after: item.snippet.slice(item.snippetMatchEnd),
  };
}
function resultKey(item: WorkspaceContentMatch) {
  return `${item.path}:${item.line}:${item.columnStart}`;
}
function resultLayout(_data: ArrayLike<WorkspaceContentMatch> | null | undefined, index: number) {
  return { length: RESULT_ROW_HEIGHT, offset: index * RESULT_ROW_HEIGHT, index };
}

/** Idle stays blank: the header placeholder already says what the field does. */
function SearchState({ state, retry }: { state: ContentSearchSnapshot; retry(): void }) {
  const { t } = useTranslation();
  if (state.status === "searching")
    return (
      <View style={styles.status} accessibilityLiveRegion="polite">
        <ThemedSpinner size={14} />
        <Text style={styles.muted}>{t("shell.commandCenter.searchingFiles")}</Text>
      </View>
    );
  if (state.status === "error")
    return (
      <View style={styles.status} accessibilityLiveRegion="polite">
        <Text style={[styles.muted, styles.error]}>{state.message}</Text>
        <Button variant="outline" size="sm" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  if (state.status === "ready")
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>{t("shell.commandCenter.noMatches")}</Text>
        {/* "No matches" alone claims the whole workspace was read. Files above the host's ceiling
            are never opened, so the empty state has to say so where the claim is made. */}
        {state.maxFileBytes ? (
          <Text style={styles.emptyDetail}>
            {t("shell.commandCenter.contentSkippedLargeFiles", {
              size: formatFileSize(state.maxFileBytes),
            })}
          </Text>
        ) : null}
      </View>
    );
  return null;
}

function ResultLimit({ limited }: { limited: boolean }) {
  const { t } = useTranslation();
  if (!limited) return null;
  return <Text style={styles.limit}>{t("shell.commandCenter.contentLimited")}</Text>;
}

function ContentPreview({
  state,
  model,
  compact,
  back,
}: {
  state: ContentSearchSnapshot;
  model: WorkspaceContentSearchModel;
  compact: boolean;
  back(): void;
}) {
  const { t } = useTranslation();
  const match = state.matches[state.activeIndex];
  const preview = state.preview;
  const location = useMemo(
    () =>
      match
        ? {
            path: match.path,
            lineStart: match.line,
            columnStart: match.columnStart,
            columnEnd: match.columnEnd,
            expectedText: match.text,
          }
        : null,
    [match],
  );
  return (
    <View style={styles.preview}>
      {match ? (
        <View style={styles.previewHeader}>
          {compact ? (
            <Button variant="ghost" size="sm" onPress={back}>
              {t("shell.commandCenter.contentBack")}
            </Button>
          ) : null}
          <Text style={styles.previewPath} numberOfLines={1} ellipsizeMode="head">
            {match.path}
          </Text>
          <Button variant="outline" size="sm" onPress={model.openSelected}>
            {t("shell.commandCenter.contentOpen")}
          </Button>
        </View>
      ) : null}
      {preview.status === "loading" ? (
        <View
          style={styles.status}
          accessibilityRole="progressbar"
          accessibilityLabel={t("shell.commandCenter.contentLoadingPreview")}
        >
          <ThemedSpinner size={14} />
        </View>
      ) : null}
      {preview.status === "error" ? (
        <View style={styles.status} accessibilityLiveRegion="polite">
          <Text style={[styles.muted, styles.error]}>{preview.message}</Text>
          <Button variant="outline" size="sm" onPress={model.retryPreview}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {preview.status === "ready" && location ? (
        <WorkspaceFileSource
          content={preview.content}
          filename={preview.path}
          size={preview.size}
          navigationRevision={state.activeIndex}
          location={location}
        />
      ) : null}
    </View>
  );
}

// Matches the Command Center's own two-line result row.
const RESULT_ROW_HEIGHT = 56;
// Characters of the matched line kept ahead of the match itself.
const SNIPPET_LEAD = 24;

const styles = StyleSheet.create((theme) => ({
  body: { flex: 1, minHeight: 0, flexDirection: "row" },
  // A result row is two truncated single lines, so extra panel width buys the list nothing and
  // buys the code preview everything: the column is a fixed reading width, capped so a narrow
  // desktop panel cannot starve the preview.
  results: {
    width: 360,
    maxWidth: "45%",
    minHeight: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  full: { width: "100%", maxWidth: "100%", borderRightWidth: 0 },
  row: {
    height: RESULT_ROW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  hovered: { backgroundColor: theme.colors.surface1 },
  selected: { backgroundColor: theme.colors.surface2 },
  // The matched line leads, in the code type scale; the location is its subtitle.
  snippet: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    fontFamily: theme.fontFamily.mono,
  },
  match: { backgroundColor: theme.colors.terminal.selectionBackground },
  // The file name and coordinates lead so that truncation eats the directory, not the identity.
  location: { fontSize: theme.fontSize.sm, lineHeight: 16 },
  locationFile: { color: theme.colors.foreground },
  locationDirectory: { color: theme.colors.foregroundMuted },
  preview: { flex: 1, minWidth: 0, minHeight: 0 },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  previewPath: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
  },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  error: { color: theme.colors.statusDanger },
  empty: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[1],
  },
  emptyText: {
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  emptyDetail: {
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  limit: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
