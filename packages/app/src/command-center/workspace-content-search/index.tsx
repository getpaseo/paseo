import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
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
import { WorkspaceContentSearchModel, type ContentSearchTransport } from "./internal/model";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

import type { WorkspaceContentMatch } from "@getpaseo/protocol/messages";
import type { ContentSearchSnapshot } from "./internal/model";
interface Props {
  compact: boolean;
  bottomSheet: boolean;
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
  compact,
  bottomSheet,
  close,
  clearScope,
  keyHandler,
}: Props & {
  transport: ContentSearchTransport;
  cwd: string;
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
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
  const onKey = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (bottomSheet) key(nativeEvent.key);
    },
    [bottomSheet, key],
  );
  const changeQuery = useCallback(
    (value: string) => {
      setPreviewPage(false);
      model.setQuery(value);
    },
    [model],
  );
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
  const empty = useMemo(() => {
    let text = "";
    if (state.status === "idle") text = t("shell.commandCenter.contentEmpty");
    if (state.status === "ready") text = t("shell.commandCenter.noMatches");
    return <Text style={styles.status}>{text}</Text>;
  }, [state.status, t]);
  return (
    <View style={styles.root}>
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
              ListEmptyComponent={empty}
            />
          </View>
        ) : null}
        {!compact || previewPage ? (
          <ContentPreview state={state} model={model} compact={compact} back={back} />
        ) : null}
      </View>
      <SearchStatus state={state} retry={model.retry} />
      <View style={styles.query}>
        <Button variant="ghost" size="sm" onPress={clearScope}>
          {t("shell.commandCenter.contentTitle")}
        </Button>
        <EditingTextInput
          initialValue={state.query}
          onChangeText={changeQuery}
          variant={bottomSheet ? "bottom-sheet" : "default"}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("shell.commandCenter.contentPlaceholder")}
          placeholder={t("shell.commandCenter.contentPlaceholder")}
          onKeyPress={onKey}
          onSubmitEditing={model.openSelected}
          style={styles.input}
        />
      </View>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.path}:${item.line}:${item.columnStart} ${item.snippet}`}
      accessibilityState={accessibilityState}
      aria-pressed={isWeb ? selected : undefined}
      onPress={onPress}
      style={[styles.row, selected && styles.selected]}
    >
      <Text style={styles.path} numberOfLines={1}>
        {item.path}:{item.line}:{item.columnStart}
      </Text>
      <Text style={styles.snippet} numberOfLines={1}>
        {item.snippet.slice(0, item.snippetMatchStart)}
        <Text style={styles.match}>
          {item.snippet.slice(item.snippetMatchStart, item.snippetMatchEnd)}
        </Text>
        {item.snippet.slice(item.snippetMatchEnd)}
      </Text>
    </Pressable>
  );
}
function resultKey(item: WorkspaceContentMatch) {
  return `${item.path}:${item.line}:${item.columnStart}`;
}
function resultLayout(_data: ArrayLike<WorkspaceContentMatch> | null | undefined, index: number) {
  return { length: 56, offset: index * 56, index };
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
      <View style={styles.previewHeader}>
        {compact ? (
          <Button variant="ghost" size="sm" onPress={back}>
            {t("shell.commandCenter.contentBack")}
          </Button>
        ) : null}
        <Text style={styles.previewPath} numberOfLines={1}>
          {match?.path ?? t("shell.commandCenter.contentPreview")}
        </Text>
        <Button variant="outline" size="sm" disabled={!match} onPress={model.openSelected}>
          {t("shell.commandCenter.contentOpen")}
        </Button>
      </View>
      {preview.status === "loading" ? (
        <Text style={styles.status}>{t("shell.commandCenter.contentLoadingPreview")}</Text>
      ) : null}
      {preview.status === "error" ? (
        <View style={styles.status}>
          <Text style={styles.error}>{preview.message}</Text>
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
function SearchStatus({ state, retry }: { state: ContentSearchSnapshot; retry(): void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.statusRow} accessibilityLiveRegion="polite">
      {state.status === "searching" ? (
        <>
          <ThemedSpinner size={14} />
          <Text style={styles.hint}>{t("shell.commandCenter.searchingFiles")}</Text>
        </>
      ) : null}
      {state.status === "error" ? (
        <>
          <Text style={[styles.hint, styles.error]}>{state.message}</Text>
          <Button variant="outline" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </>
      ) : null}
      {state.limited ? (
        <Text style={styles.hint}>{t("shell.commandCenter.contentLimited")}</Text>
      ) : null}
      {state.status === "idle" || (state.status === "ready" && !state.limited) ? (
        <Text
          style={styles.hint}
          accessibilityHint={t("shell.commandCenter.contentScopeDetail")}
          aria-description={isWeb ? t("shell.commandCenter.contentScopeDetail") : undefined}
        >
          {t("shell.commandCenter.contentScope")}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  body: { flex: 1, minHeight: 0, flexDirection: "row" },
  results: {
    width: "40%",
    minHeight: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  full: { width: "100%", borderRightWidth: 0 },
  row: {
    height: 56,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  selected: { backgroundColor: theme.colors.surface2 },
  path: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  snippet: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  match: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.terminal.selectionBackground,
  },
  preview: { flex: 1, minWidth: 0, minHeight: 0 },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  previewPath: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  status: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusRow: {
    minHeight: 40,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hint: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  error: { color: theme.colors.statusDanger },
  query: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    ...(isWeb ? { outlineWidth: 0 } : {}),
  },
}));
