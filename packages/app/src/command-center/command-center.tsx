import {
  FlatList,
  Modal,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  type BottomSheetFlatListMethods,
} from "@gorhom/bottom-sheet";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { Shortcut } from "@/components/ui/shortcut";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { useHosts } from "@/runtime/host-runtime";
import {
  useKeyboardShortcutsStore,
  type CommandCenterScope,
} from "@/stores/keyboard-shortcuts-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import { focusWithRetries } from "@/utils/web-focus";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { useCommandCenterContributions } from "./provider";
import {
  buildContributionSections,
  joinSubtitleParts,
  moveActiveResultId,
  preserveActiveResultId,
  projectCommandCenterRows,
  type CommandCenterAgentResult,
  type CommandCenterFileResult,
  type CommandCenterListRow,
  type CommandCenterResult,
  type CommandCenterResultSection,
  type CommandCenterWorkspaceResult,
} from "./results";
import { useWorkspaceFileSearch } from "./workspace-file-search";

const ThemedBottomSheetTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedFolder = withUnistyles(Folder, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedCheck = withUnistyles(Check, (theme) => ({ color: theme.colors.foreground }));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedX = withUnistyles(X, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const COMMAND_CENTER_SNAP_POINTS = ["60%", "90%"];
const KEYBOARD_SHOULD_PERSIST_TAPS = "always" as const;
const DEFAULT_CATEGORY_RESULT_LIMIT = 5;

function sortAgents(left: AggregatedAgent, right: AggregatedAgent): number {
  const leftNeedsInput = (left.pendingPermissionCount ?? 0) > 0 ? 1 : 0;
  const rightNeedsInput = (right.pendingPermissionCount ?? 0) > 0 ? 1 : 0;
  if (leftNeedsInput !== rightNeedsInput) return rightNeedsInput - leftNeedsInput;
  const leftAttention = left.requiresAttention ? 1 : 0;
  const rightAttention = right.requiresAttention ? 1 : 0;
  if (leftAttention !== rightAttention) return rightAttention - leftAttention;
  const leftRunning = left.status === "running" ? 1 : 0;
  const rightRunning = right.status === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) return rightRunning - leftRunning;
  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function matchesQuery(searchText: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || searchText.includes(normalized);
}

function limitDefaultCategoryResults<Result>(results: Result[], query: string): Result[] {
  return query.trim() ? results : results.slice(0, DEFAULT_CATEGORY_RESULT_LIMIT);
}

function useBuiltInSections(open: boolean, query: string): CommandCenterResultSection[] {
  const { t } = useTranslation();
  const { agents } = useAggregatedAgents();
  const { projects } = useProjects({ enabled: open });
  const showHost = useHosts().length > 1;

  return useMemo(() => {
    if (!open) return [];
    const allWorkspaces: CommandCenterWorkspaceResult[] = [];
    for (const project of projects) {
      for (const host of project.hosts) {
        for (const workspace of host.workspaces) {
          if (workspace.archivingAt) continue;
          const title = workspace.title ?? workspace.name;
          const subtitle = joinSubtitleParts([
            showHost ? host.serverName : null,
            project.projectName,
            workspace.currentBranch,
          ]);
          const searchText = `${title} ${subtitle}`.toLowerCase();
          allWorkspaces.push({
            kind: "workspace",
            id: `workspace:${host.serverId}:${workspace.id}`,
            title,
            subtitle,
            searchText,
            run: () => {
              clearCommandCenterFocusRestoreElement();
              navigateToWorkspace({ serverId: host.serverId, workspaceId: workspace.id });
            },
          });
        }
      }
    }
    allWorkspaces.sort((left, right) => {
      const titleDelta = left.title.localeCompare(right.title, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return titleDelta || left.subtitle.localeCompare(right.subtitle);
    });
    const workspaceTitleByKey = new Map(
      allWorkspaces.map((workspace) => [workspace.id.slice("workspace:".length), workspace.title]),
    );
    const workspaces = limitDefaultCategoryResults(
      allWorkspaces.filter((workspace) => matchesQuery(workspace.searchText, query)),
      query,
    );
    const agentResults = limitDefaultCategoryResults(
      agents
        .map<CommandCenterAgentResult>((agent) => {
          const title = agent.title || t("shell.commandCenter.newAgent");
          const workspaceTitle = agent.workspaceId
            ? workspaceTitleByKey.get(`${agent.serverId}:${agent.workspaceId}`)
            : undefined;
          const location = workspaceTitle ?? shortenPath(agent.cwd);
          const subtitle = joinSubtitleParts([
            showHost ? agent.serverLabel : null,
            location,
            formatTimeAgo(agent.lastActivityAt),
          ]);
          return {
            kind: "agent",
            id: `agent:${agent.serverId}:${agent.id}`,
            agent,
            title,
            subtitle,
            searchText: `${title} ${subtitle} ${agent.cwd}`.toLowerCase(),
            run: () => {
              clearCommandCenterFocusRestoreElement();
              navigateToAgent({ serverId: agent.serverId, agentId: agent.id });
            },
          };
        })
        .filter((agent) => matchesQuery(agent.searchText, query))
        .sort((left, right) => sortAgents(left.agent, right.agent)),
      query,
    );
    return [
      {
        id: "workspaces",
        rank: 2,
        title: t("shell.commandCenter.workspaces"),
        results: workspaces,
      },
      { id: "agents", rank: 3, title: t("shell.commandCenter.agents"), results: agentResults },
    ];
  }, [agents, open, projects, query, showHost, t]);
}

interface CommandCenterState {
  open: boolean;
  scope: CommandCenterScope;
  clearScope(): void;
  query: string;
  setQuery(query: string): void;
  activeId: string | null;
  rows: readonly CommandCenterListRow[];
  results: readonly CommandCenterResult[];
  rowIndexByResultId: ReadonlyMap<string, number>;
  offsets: readonly number[];
  inputRef: React.RefObject<EditingTextInputHandle | null>;
  fileSearchLoading: boolean;
  fileSearchError: string | null;
  close(): void;
  select(result: CommandCenterResult): void;
  key(key: string): boolean;
}

function useCommandCenterState(): CommandCenterState {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const { t } = useTranslation();
  const open = useKeyboardShortcutsStore((state) => state.commandCenterOpen);
  const scope = useKeyboardShortcutsStore((state) => state.commandCenterScope);
  const setOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const setScope = useKeyboardShortcutsStore((state) => state.setCommandCenterScope);
  const snapshot = useCommandCenterContributions();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const previousOpenRef = useRef(open);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const builtInSections = useBuiltInSections(open, query);
  const {
    entries: fileSearchEntries,
    loading: fileSearchLoading,
    error: fileSearchError,
    openFile,
  } = useWorkspaceFileSearch({
    enabled: open && (scope === "files" || Boolean(query.trim())),
    query,
  });
  const fileSections = useMemo<CommandCenterResultSection[]>(() => {
    const results = fileSearchEntries.map<CommandCenterFileResult>((entry) => ({
      kind: "file",
      id: `file:${entry.path}`,
      filePath: entry.path,
      title: entry.name,
      subtitle: entry.directory,
      searchText: entry.path.toLowerCase(),
      run: () => openFile(entry.path),
    }));
    return [{ id: "files", rank: 4, title: t("shell.commandCenter.files"), results }];
  }, [fileSearchEntries, openFile, t]);
  const contributionSections = useMemo(
    () => buildContributionSections(snapshot.contributions, query),
    [query, snapshot.contributions],
  );
  const projection = useMemo(
    () =>
      projectCommandCenterRows(
        scope === "files"
          ? fileSections
          : [...contributionSections, ...fileSections, ...builtInSections],
      ),
    [builtInSections, contributionSections, fileSections, scope],
  );
  const resolvedActiveId = preserveActiveResultId(activeId, projection.selectableResults);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const select = useCallback(
    (result: CommandCenterResult) => {
      setOpen(false);
      void result.run();
    },
    [setOpen],
  );
  const key = useCallback(
    (pressed: string): boolean => {
      if (!open) return false;
      const results = projection.selectableResults;
      if (pressed === "Escape") {
        close();
        return true;
      }
      if (pressed === "Backspace" && !query.trim() && scope) {
        setScope(null);
        return true;
      }
      if (pressed === "Enter") {
        const selected = results.find((result) => result.id === resolvedActiveId);
        if (!selected) return false;
        select(selected);
        return true;
      }
      if (pressed !== "ArrowDown" && pressed !== "ArrowUp") return false;
      if (results.length === 0) return false;
      const direction = pressed === "ArrowDown" ? "next" : "previous";
      setActiveId(moveActiveResultId(resolvedActiveId, results, direction));
      return true;
    },
    [close, open, projection.selectableResults, query, resolvedActiveId, scope, select, setScope],
  );

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    setQuery("");
    setActiveId(null);
    if (!wasOpen) return;
    const element = takeCommandCenterFocusRestoreElement();
    if (!element) return;
    const cancel = focusWithRetries({
      focus: () => element.focus(),
      isFocused: () => typeof document !== "undefined" && document.activeElement === element,
      onTimeout: () =>
        keyboardActionDispatcher.dispatch({ id: "message-input.focus", scope: "message-input" }),
    });
    return cancel;
  }, [keyboardActionDispatcher, open]);

  return {
    open,
    scope,
    clearScope: () => setScope(null),
    query,
    setQuery,
    activeId: resolvedActiveId,
    rows: projection.rows,
    results: projection.selectableResults,
    rowIndexByResultId: projection.rowIndexByResultId,
    offsets: projection.offsets,
    inputRef,
    fileSearchLoading,
    fileSearchError,
    close,
    select,
    key,
  };
}

interface ResultRowProps {
  result: CommandCenterResult;
  active: boolean;
  onSelect(result: CommandCenterResult): void;
}

const ResultRow = memo(function ResultRow({ result, active, onSelect }: ResultRowProps) {
  const press = useCallback(() => onSelect(result), [onSelect, result]);
  const choice =
    result.kind === "contribution" && result.contribution.presentation.kind === "choice"
      ? result.contribution.presentation
      : null;
  const accessibilityLabel =
    result.kind === "file"
      ? [result.title, result.subtitle].filter(Boolean).join(" ")
      : choice?.path.join(" › ");
  const accessibilityState = useMemo(
    () => (isNative && choice ? { selected: choice.selected } : undefined),
    [choice],
  );
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (result.kind === "agent" ||
        result.kind === "workspace" ||
        (result.kind === "contribution" &&
          result.contribution.presentation.kind === "action" &&
          Boolean(result.contribution.presentation.subtitle))) &&
        styles.tallRow,
      (Boolean(hovered) || pressed || active) && styles.activeRow,
    ],
    [active, result],
  );
  return (
    <Pressable
      style={style}
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      aria-pressed={isWeb ? choice?.selected : undefined}
      testID={
        result.kind === "file" ? `command-center-file-row-${result.filePath}` : choice?.testId
      }
    >
      <ResultContent result={result} />
    </Pressable>
  );
});

function ResultContent({ result }: { result: CommandCenterResult }) {
  if (result.kind === "file") {
    return (
      <View style={styles.rowContent}>
        <View style={styles.rowMain}>
          <View style={styles.iconSlot} testID="command-center-file-icon">
            <MaterialFileIcon fileName={result.title} size={16} />
          </View>
          <Text style={styles.fileLine} numberOfLines={1} testID="command-center-file-line">
            <Text style={styles.fileName} testID="command-center-file-name">
              {result.title}
            </Text>
            {result.subtitle ? (
              <Text style={styles.filePath} testID="command-center-file-path">
                {" "}
                {result.subtitle}
              </Text>
            ) : null}
          </Text>
        </View>
      </View>
    );
  }
  if (result.kind === "agent") {
    const agent = result.agent;
    return (
      <View style={styles.rowContent} testID={`command-center-agent-${agent.serverId}:${agent.id}`}>
        <View style={styles.rowMain}>
          <View style={styles.iconSlot}>
            <AgentStatusDot
              status={agent.status}
              requiresAttention={agent.requiresAttention}
              showInactive
            />
          </View>
          <View style={styles.textContent}>
            <Text style={styles.title} numberOfLines={1}>
              {result.title}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1} testID="command-center-agent-subtitle">
              {result.subtitle}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  if (result.kind === "workspace") {
    const key = result.id.slice("workspace:".length);
    return (
      <View style={styles.rowContent} testID={`command-center-workspace-${key}`}>
        <View style={styles.rowMain}>
          <View style={styles.iconSlot}>
            <ThemedFolder size={16} strokeWidth={2.2} />
          </View>
          <View style={styles.textContent}>
            <Text style={styles.title} numberOfLines={1}>
              {result.title}
            </Text>
            <Text
              style={styles.subtitle}
              numberOfLines={1}
              testID="command-center-workspace-subtitle"
            >
              {result.subtitle}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  const presentation = result.contribution.presentation;
  const Icon = presentation.icon;
  if (presentation.kind === "action") {
    return (
      <View style={styles.rowContent}>
        <View style={styles.rowMain}>
          {Icon ? (
            <View style={styles.iconSlot}>
              <Icon size={16} />
            </View>
          ) : null}
          <View style={styles.textContent}>
            <Text style={styles.title} numberOfLines={1}>
              {presentation.title}
            </Text>
            {presentation.subtitle ? (
              <Text style={styles.subtitle}>{presentation.subtitle}</Text>
            ) : null}
          </View>
        </View>
        {presentation.shortcutKeys ? (
          <Shortcut chord={presentation.shortcutKeys} style={styles.rowShortcut} />
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.rowContent}>
      <View style={styles.rowMain}>
        {Icon ? (
          <View style={styles.iconSlot}>
            <Icon size={16} />
          </View>
        ) : null}
        <View style={styles.breadcrumb}>
          {presentation.path.map((part, index) => (
            <View
              key={presentation.path.slice(0, index + 1).join("\u0000")}
              style={styles.breadcrumbPart}
            >
              {index > 0 ? <ThemedChevronRight size={13} strokeWidth={2} /> : null}
              <Text
                style={
                  index === presentation.path.length - 1 ? styles.title : styles.breadcrumbGroup
                }
                numberOfLines={1}
              >
                {part}
              </Text>
            </View>
          ))}
        </View>
      </View>
      {presentation.selected ? (
        <View style={styles.iconSlot}>
          <ThemedCheck size={16} strokeWidth={2.2} />
        </View>
      ) : null}
    </View>
  );
}

function SectionRow({ row }: { row: Extract<CommandCenterListRow, { kind: "section" }> }) {
  let sizeStyle = styles.dividerSection;
  if (row.title && row.divider) sizeStyle = styles.dividedSection;
  if (row.title && !row.divider) sizeStyle = styles.titledSection;
  return (
    <View style={sizeStyle}>
      {row.divider ? <View style={styles.sectionDivider} /> : null}
      {row.title ? <Text style={styles.sectionLabel}>{row.title}</Text> : null}
    </View>
  );
}

export function CommandCenter() {
  const { t } = useTranslation();
  const state = useCommandCenterState();
  const isCompact = useIsCompactFormFactor();
  const showBottomSheet = isCompact && isNative;
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && state.open && !showBottomSheet);
  const listRef = useRef<FlatList<CommandCenterListRow>>(null);
  const bottomSheetListRef = useRef<BottomSheetFlatListMethods>(null);
  const bottomSheetInputRef = useRef<EditingTextInputHandle>(null);
  const scrollMetricsRef = useRef({ offset: 0, visibleLength: 0 });
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: state.open,
    isEnabled: showBottomSheet,
    onClose: state.close,
  });

  const revealActiveResult = useCallback(() => {
    if (!state.open || !state.activeId) return;
    const index = state.rowIndexByResultId.get(state.activeId);
    if (index === undefined) return;
    const { offset, visibleLength } = scrollMetricsRef.current;
    if (visibleLength <= 0) return;
    const rowTop = state.offsets[index];
    const rowBottom = rowTop + state.rows[index].height;
    let nextOffset: number | null = null;
    if (rowTop < offset) nextOffset = rowTop;
    if (rowBottom > offset + visibleLength) nextOffset = rowBottom - visibleLength;
    if (nextOffset === null) return;
    const ref = showBottomSheet ? bottomSheetListRef.current : listRef.current;
    const boundedOffset = Math.max(0, nextOffset);
    scrollMetricsRef.current.offset = boundedOffset;
    ref?.scrollToOffset({ offset: boundedOffset, animated: false });
  }, [
    showBottomSheet,
    state.activeId,
    state.offsets,
    state.open,
    state.rowIndexByResultId,
    state.rows,
  ]);
  useEffect(() => {
    if (!state.open) {
      scrollMetricsRef.current = { offset: 0, visibleLength: 0 };
      return;
    }
    revealActiveResult();
  }, [revealActiveResult, state.open]);
  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      scrollMetricsRef.current.visibleLength = event.nativeEvent.layout.height;
      revealActiveResult();
    },
    [revealActiveResult],
  );
  const handleListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollMetricsRef.current.offset = event.nativeEvent.contentOffset.y;
  }, []);
  useEffect(() => {
    if (!showBottomSheet || !state.open) return;
    const timer = setTimeout(() => bottomSheetInputRef.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, [showBottomSheet, state.open]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<CommandCenterListRow>) =>
      item.kind === "section" ? (
        <SectionRow row={item} />
      ) : (
        <ResultRow
          result={item.result}
          active={item.result.id === state.activeId}
          onSelect={state.select}
        />
      ),
    [state.activeId, state.select],
  );
  const getItemLayout = useCallback(
    (_data: ArrayLike<CommandCenterListRow> | null | undefined, index: number) => ({
      index,
      length: state.rows[index].height,
      offset: state.offsets[index],
    }),
    [state.offsets, state.rows],
  );
  const keyExtractor = useCallback((row: CommandCenterListRow) => row.key, []);
  const empty = useMemo(
    () =>
      state.fileSearchError || state.fileSearchLoading ? null : (
        <Text style={styles.emptyText}>{t("shell.commandCenter.noMatches")}</Text>
      ),
    [state.fileSearchError, state.fileSearchLoading, t],
  );
  const fileSearchError = useMemo(
    () =>
      state.fileSearchError ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.errorText}
          testID="command-center-file-search-error"
        >
          {t("common.errors.error")}: {state.fileSearchError}
        </Text>
      ) : null,
    [state.fileSearchError, t],
  );
  const commonListProps = {
    data: state.rows,
    renderItem,
    keyExtractor,
    getItemLayout,
    ListEmptyComponent: empty,
    style: styles.results,
    testID: "command-center-results",
    keyboardShouldPersistTaps: KEYBOARD_SHOULD_PERSIST_TAPS,
    showsVerticalScrollIndicator: false,
    initialNumToRender: 12,
    maxToRenderPerBatch: 10,
    windowSize: 5,
    onLayout: handleListLayout,
    onScroll: handleListScroll,
    scrollEventThrottle: 16,
  };
  const keyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => state.key(key),
    [state],
  );
  const submit = useCallback(() => state.key("Enter"), [state]);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!state.key(event.key)) return false;
      event.preventDefault();
      return true;
    },
    [state],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && state.open && !showBottomSheet,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });
  const backdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  if (showBottomSheet) {
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        contextBridge={null}
        snapPoints={COMMAND_CENTER_SNAP_POINTS}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleSheetDismiss}
        backdropComponent={backdrop}
        enablePanDownToClose
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.sheetHandle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
      >
        <View style={[styles.bottomSheetHeader, styles.searchRow]} testID="command-center-header">
          {state.scope === "files" ? (
            <ScopeChip label={t("shell.commandCenter.files")} onRemove={state.clearScope} />
          ) : null}
          <ThemedBottomSheetTextInput
            testID="command-center-input"
            ref={bottomSheetInputRef}
            initialValue={state.query}
            variant="bottom-sheet"
            onChangeText={state.setQuery}
            onKeyPress={keyPress}
            onSubmitEditing={submit}
            placeholder={
              state.scope === "files"
                ? t("shell.commandCenter.filePlaceholder")
                : t("shell.commandCenter.placeholder")
            }
            style={[styles.input, styles.growingInput]}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <FileSearchLoadingIndicator
            loading={state.fileSearchLoading}
            label={t("shell.commandCenter.searchingFiles")}
          />
        </View>
        {fileSearchError}
        <BottomSheetFlatList ref={bottomSheetListRef} {...commonListProps} />
      </IsolatedBottomSheetModal>
    );
  }
  if (!state.open) return null;
  return (
    <OverlayLayerProvider layer={isWeb ? modalLayer : 0}>
      <Modal visible transparent animationType="fade" onRequestClose={state.close}>
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={state.close} />
          <View ref={setWebOverlayScope} testID="command-center-panel" style={styles.panel}>
            <View style={[styles.header, styles.searchRow]} testID="command-center-header">
              {state.scope === "files" ? (
                <ScopeChip label={t("shell.commandCenter.files")} onRemove={state.clearScope} />
              ) : null}
              <ThemedTextInput
                testID="command-center-input"
                ref={state.inputRef}
                initialValue={state.query}
                onChangeText={state.setQuery}
                placeholder={
                  state.scope === "files"
                    ? t("shell.commandCenter.filePlaceholder")
                    : t("shell.commandCenter.placeholder")
                }
                style={[styles.input, styles.growingInput]}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <FileSearchLoadingIndicator
                loading={state.fileSearchLoading}
                label={t("shell.commandCenter.searchingFiles")}
              />
            </View>
            {fileSearchError}
            <FlatList ref={listRef} {...commonListProps} />
          </View>
        </View>
      </Modal>
    </OverlayLayerProvider>
  );
}

function FileSearchLoadingIndicator({ loading, label }: { loading: boolean; label: string }) {
  return (
    <View style={styles.fileSearchStatus} testID="command-center-file-search-status">
      {loading ? (
        <View
          accessibilityLabel={label}
          accessibilityRole="progressbar"
          testID="command-center-file-search-loading"
        >
          <ThemedLoadingSpinner size={14} />
        </View>
      ) : null}
    </View>
  );
}

// The chip sits at the input's own height and type size so it reads as the scope of the field
// rather than a badge dropped into the query. Its 28px matches the input's line box, so showing or
// dropping the scope cannot resize the header.
function ScopeChip({ label, onRemove }: { label: string; onRemove(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onRemove}
      style={styles.scopeChip}
      testID="command-center-files-scope"
    >
      <ThemedFolder size={14} strokeWidth={2.2} />
      <Text style={styles.scopeChipLabel}>{label}</Text>
      <ThemedX size={12} strokeWidth={2.2} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  panel: {
    width: 640,
    height: 560,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
    ...theme.shadow.lg,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  input: {
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
    color: theme.colors.foreground,
    outlineWidth: 0,
  },
  growingInput: { flex: 1, minWidth: 0 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  fileSearchStatus: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  scopeChip: {
    // Stretching to the row rather than setting a height keeps the chip exactly as tall as the
    // input's line box, so showing or dropping the scope can never resize the header.
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginRight: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  scopeChipLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
  },
  results: { flex: 1 },
  sectionLabel: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sectionDivider: {
    height: 1,
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.border,
  },
  row: { height: 36, paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
  tallRow: { height: 56 },
  activeRow: { backgroundColor: theme.colors.surface1 },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  textContent: { flex: 1, minWidth: 0 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
    flexShrink: 1,
  },
  fileLine: { flex: 1, minWidth: 0, fontSize: theme.fontSize.base, lineHeight: 20 },
  fileName: { color: theme.colors.foreground },
  filePath: { color: theme.colors.foregroundMuted },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 16 },
  iconSlot: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  rowShortcut: { flexShrink: 0 },
  breadcrumb: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  breadcrumbPart: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  breadcrumbGroup: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    flexShrink: 0,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
  sheetBackground: { backgroundColor: theme.colors.surface0 },
  sheetHandle: { backgroundColor: theme.colors.palette.zinc[600] },
  titledSection: { height: 32, justifyContent: "flex-end" },
  dividedSection: { height: 49, justifyContent: "flex-end" },
  dividerSection: { height: 17, justifyContent: "flex-end" },
}));
