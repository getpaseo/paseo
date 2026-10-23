import equal from "fast-deep-equal";
import { recordRenderProfileReasons } from "@/utils/render-profiler";
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
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BottomSheetFlatList, type BottomSheetFlatListMethods } from "@gorhom/bottom-sheet";
import { useAgentDescriptor, resolveAgentLabel } from "@/agent-presentation";
import { StatusIcon } from "@/components/status-icon";
import { useWorkspaceStatus } from "@/workspace-status";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { HighlightedText, type HighlightedTextProps } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { ProjectIconView } from "@/components/project-icon-view";
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
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { createProjectIconTarget } from "@/projects/icon-target";
import { useProjectIcons } from "@/projects/icons";
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
import { shortenPath } from "@/utils/shorten-path";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import {
  COMMAND_CENTER_LINE_HEIGHT,
  COMMAND_CENTER_LIST_METRICS,
  COMMAND_CENTER_SECTION_GAP,
  type CommandCenterListMetrics,
} from "./list-metrics";
import { useCommandCenterContributions } from "./provider";
import { filterAndRankWorkspaces } from "./workspace-search";
import {
  buildContributionSections,
  filterAndRankBuiltInResults,
  joinSubtitleParts,
  PINNED_SECTION_BAND,
  projectCommandCenterRows,
  type CommandCenterAgentResult,
  type CommandCenterFileResult,
  type CommandCenterListRow,
  type CommandCenterResult,
  type CommandCenterResultSection,
  type CommandCenterSearchFields,
  type CommandCenterWorkspaceResult,
} from "./results";
import { createCommandCenterInteraction, type CommandCenterInteraction } from "./interaction";
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

/** `cwd` is not rendered, so a path match must never outrank a match on text the user can see. */
function agentSearchFields(result: CommandCenterAgentResult): CommandCenterSearchFields {
  return { visible: [result.title, result.subtitle], hidden: [result.agent.cwd] };
}

function createWorkspaceResultAction(serverId: string, workspaceId: string) {
  return () => {
    clearCommandCenterFocusRestoreElement();
    navigateToWorkspace({ serverId, workspaceId });
  };
}

function createAgentResultAction(serverId: string, agentId: string) {
  return () => {
    clearCommandCenterFocusRestoreElement();
    navigateToAgent({ serverId, agentId });
  };
}

/**
 * Build every pinned row. Deliberately not keyed on `query`: none of this work depends on what
 * was typed. Ordering belongs to `filterAndRankBuiltInResults`, which ranks on every keystroke.
 */
function useBuiltInRows(open: boolean): {
  workspaces: CommandCenterWorkspaceResult[];
  agents: CommandCenterAgentResult[];
} {
  const { t } = useTranslation();
  const previousRows = useRef(
    new Map<string, CommandCenterAgentResult | CommandCenterWorkspaceResult>(),
  );
  const { agents } = useAggregatedAgents({ demand: open });
  const { projects } = useProjects({ enabled: open });
  const showHost = useHosts().length > 1;
  const iconTargets = useMemo(
    () =>
      open
        ? projects.flatMap((project) =>
            project.hosts.flatMap((host) => {
              const target = createProjectIconTarget({
                projectViewKey: project.viewKey,
                placement: { ...host, iconWorkingDir: host.repoRoot },
              });
              return target ? [target] : [];
            }),
          )
        : [],
    [open, projects],
  );
  const iconDataByProjectViewKey = useProjectIcons({ projects: iconTargets });

  return useMemo(() => {
    if (!open) {
      previousRows.current.clear();
      return { workspaces: [], agents: [] };
    }
    // Built-in IDs identify immutable navigation targets. Reuse their callbacks and unchanged
    // row data so a directory update does not invalidate every mounted ResultRow.
    const nextRows = new Map<string, CommandCenterAgentResult | CommandCenterWorkspaceResult>();
    const preserve = <T extends CommandCenterAgentResult | CommandCenterWorkspaceResult>(
      row: T,
    ): T => {
      const previous = previousRows.current.get(row.id);
      if (previous) row.run = previous.run;
      const stable = previous && equal(previous, row) ? (previous as T) : row;
      nextRows.set(row.id, stable);
      return stable;
    };
    const allWorkspaces: CommandCenterWorkspaceResult[] = [];
    for (const project of projects) {
      const workspaceProject = {
        viewKey: project.viewKey,
        name: project.projectName,
        iconDataUri: iconDataByProjectViewKey.get(project.viewKey) ?? null,
      };
      for (const host of project.hosts) {
        for (const workspace of host.workspaces) {
          if (workspace.archivingAt) continue;
          allWorkspaces.push(
            preserve({
              kind: "workspace",
              id: `workspace:${host.serverId}:${workspace.id}`,
              title: workspace.title ?? workspace.name,
              subtitle: joinSubtitleParts([
                showHost ? host.serverName : null,
                project.projectName,
                workspace.currentBranch,
              ]),
              serverId: host.serverId,
              workspaceId: workspace.id,
              project: workspaceProject,
              changeRequestNumber: workspace.changeRequestNumber,
              activityAt: workspace.statusEnteredAt,
              run: createWorkspaceResultAction(host.serverId, workspace.id),
            }),
          );
        }
      }
    }
    const workspaceTitleByKey = new Map(
      allWorkspaces.map((workspace) => [workspace.id.slice("workspace:".length), workspace.title]),
    );
    const agentRows = agents.map<CommandCenterAgentResult>((agent) => {
      const workspaceTitle = agent.workspaceId
        ? workspaceTitleByKey.get(`${agent.serverId}:${agent.workspaceId}`)
        : undefined;
      return preserve({
        kind: "agent",
        id: `agent:${agent.serverId}:${agent.id}`,
        agent,
        title: resolveAgentLabel(agent.title) ?? t("workspace.tabs.loading"),
        subtitle: joinSubtitleParts([
          showHost ? agent.serverLabel : null,
          workspaceTitle ?? shortenPath(agent.cwd),
        ]),
        activityAt: agent.lastActivityAt,
        run: createAgentResultAction(agent.serverId, agent.id),
      });
    });
    previousRows.current = nextRows;
    return { workspaces: allWorkspaces, agents: agentRows };
  }, [agents, iconDataByProjectViewKey, open, projects, showHost, t]);
}

function useBuiltInSections(open: boolean, query: string): CommandCenterResultSection[] {
  const { t } = useTranslation();
  const rows = useBuiltInRows(open);

  return useMemo(() => {
    if (!open) return [];
    return [
      {
        id: "workspaces",
        band: PINNED_SECTION_BAND,
        rank: 2,
        title: t("shell.commandCenter.workspaces"),
        results: filterAndRankWorkspaces(rows.workspaces, query),
      },
      {
        id: "agents",
        band: PINNED_SECTION_BAND,
        rank: 3,
        title: t("shell.commandCenter.agents"),
        results: filterAndRankBuiltInResults(rows.agents, query, agentSearchFields),
      },
    ];
  }, [open, query, rows, t]);
}

interface CommandCenterState {
  open: boolean;
  scope: CommandCenterScope;
  clearScope(): void;
  query: string;
  setQuery(query: string): void;
  activeId: string | null;
  rows: readonly CommandCenterListRow[];
  offsets: readonly number[];
  inputRef: React.RefObject<EditingTextInputHandle | null>;
  fileSearchLoading: boolean;
  fileSearchError: string | null;
  close(): void;
  select(result: CommandCenterResult): void;
  key(key: string): boolean;
}

function useCommandCenterState(
  listMetrics: CommandCenterListMetrics,
  interaction: CommandCenterInteraction,
): CommandCenterState {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const { t } = useTranslation();
  const open = useKeyboardShortcutsStore((state) => state.commandCenterOpen);
  const scope = useKeyboardShortcutsStore((state) => state.commandCenterScope);
  const setOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const setScope = useKeyboardShortcutsStore((state) => state.setCommandCenterScope);
  const snapshot = useCommandCenterContributions();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const previousOpenRef = useRef(open);
  const { query, activeId } = useSyncExternalStore(interaction.subscribe, interaction.getSnapshot);
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
      run: () => openFile(entry.path),
    }));
    // File rows are matched by the daemon, so they carry no client-side score and cannot be
    // relevance-compared against the rows that do. Pinning them keeps the section comparator
    // total: band is decided before any score is read.
    return [
      {
        id: "files",
        band: PINNED_SECTION_BAND,
        rank: 4,
        title: t("shell.commandCenter.files"),
        results,
      },
    ];
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
        listMetrics,
      ),
    [builtInSections, contributionSections, fileSections, listMetrics, scope],
  );
  useLayoutEffect(() => {
    interaction.update({ open, scope, query, projection, loading: fileSearchLoading });
  }, [interaction, open, scope, query, projection, fileSearchLoading]);

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
        const selected = results.find((result) => result.id === activeId);
        if (!selected) return false;
        select(selected);
        return true;
      }
      if (pressed !== "ArrowDown" && pressed !== "ArrowUp") return false;
      return interaction.move(pressed === "ArrowDown" ? "next" : "previous");
    },
    [
      close,
      open,
      projection.selectableResults,
      query,
      activeId,
      scope,
      select,
      setScope,
      interaction,
    ],
  );

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
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
    setQuery: interaction.setQuery,
    activeId,
    rows: projection.rows,
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
  height: number;
  query: string;
  active: boolean;
  onSelect(result: CommandCenterResult): void;
}

const ResultRow = memo(function ResultRow({
  result,
  height,
  query,
  active,
  onSelect,
}: ResultRowProps) {
  recordRenderProfileReasons(`CommandCenterResultRow:${result.id}`, ["render"]);
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
      { height },
      (Boolean(hovered) || pressed || active) && styles.activeRow,
    ],
    [active, height],
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
      {(state) => (
        <ResultContent
          result={result}
          query={query}
          backdrop={
            active ||
            state.pressed ||
            Boolean((state as PressableStateCallbackType & { hovered?: boolean }).hovered)
              ? "surface1"
              : "surface0"
          }
        />
      )}
    </Pressable>
  );
});

/**
 * Text with the query's terms marked. Marks use the same matcher options the rows were ranked
 * with, so a mark always points at something that made the row match.
 */
function QueryHighlightedText({
  query,
  text,
  ...props
}: { query: string } & Omit<HighlightedTextProps, "ranges">) {
  const ranges = useMemo(() => findHighlightRanges(query, text), [query, text]);
  return <HighlightedText text={text} ranges={ranges} {...props} />;
}

/**
 * The subtitle line of a workspace or agent row. The timestamp is its own text so a long branch
 * truncates without pushing the time out of view, and so the time is never part of what the
 * query matches against. It keeps itself current while the command center stays open.
 */
function SubtitleWithTimestamp({
  query,
  subtitle,
  activityAt,
  testID,
}: {
  query: string;
  subtitle: string;
  activityAt: Date | null;
  testID: string;
}) {
  const timeAgo = useTimeAgo(activityAt);
  return (
    <View style={styles.subtitleLine}>
      <QueryHighlightedText
        query={query}
        text={subtitle}
        style={[styles.subtitle, styles.subtitleText]}
        numberOfLines={1}
        testID={testID}
      />
      {timeAgo ? (
        <Text style={styles.subtitle} numberOfLines={1} testID="command-center-result-timestamp">
          {/* Non-breaking: web collapses a leading plain space in its own flex item. */}
          {subtitle ? `\u00a0· ${timeAgo}` : timeAgo}
        </Text>
      ) : null}
    </View>
  );
}

const providerIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function AgentResultContent({
  result,
  query,
  backdrop,
}: {
  result: CommandCenterAgentResult;
  query: string;
  backdrop: SurfaceBackdrop;
}) {
  const agent = result.agent;
  const descriptor = useAgentDescriptor(
    { kind: "agent", agentId: agent.id },
    { serverId: agent.serverId },
  );
  const Icon = useMemo(
    () => withUnistyles(descriptor.icon, providerIconMapping),
    [descriptor.icon],
  );
  return (
    <View style={styles.rowContent} testID={`command-center-agent-${agent.serverId}:${agent.id}`}>
      <View style={styles.rowMain}>
        <View style={styles.iconSlot}>
          <StatusIcon statusBucket={descriptor.statusBucket} size={16} backdrop={backdrop}>
            <View accessibilityRole="image" accessibilityLabel={descriptor.subtitle}>
              <Icon size={16} />
            </View>
          </StatusIcon>
        </View>
        <View style={styles.textContent}>
          <QueryHighlightedText
            query={query}
            text={result.title}
            style={styles.title}
            numberOfLines={1}
          />
          <SubtitleWithTimestamp
            query={query}
            subtitle={result.subtitle}
            activityAt={result.activityAt}
            testID="command-center-agent-subtitle"
          />
        </View>
      </View>
    </View>
  );
}

function WorkspaceResultIcon({
  result,
  backdrop,
}: {
  result: CommandCenterWorkspaceResult;
  backdrop: SurfaceBackdrop;
}) {
  const statusBucket = useWorkspaceStatus(result.serverId, result.workspaceId);
  return (
    <StatusIcon statusBucket={statusBucket} size={16} backdrop={backdrop}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
        <WorkspaceProjectIcon project={result.project} />
      </View>
    </StatusIcon>
  );
}

/** The same project icon the sidebar's workspace rows lead with: its image, or a lettered square. */
function WorkspaceProjectIcon({ project }: { project: CommandCenterWorkspaceResult["project"] }) {
  const initial = projectIconPlaceholderLabelFromDisplayName(project.name).charAt(0).toUpperCase();
  return (
    <ProjectIconView
      iconDataUri={project.iconDataUri}
      initial={initial}
      projectViewKey={project.viewKey}
      size={16}
      textStyle={styles.projectIconFallbackText}
    />
  );
}

function ResultContent({
  result,
  query,
  backdrop,
}: {
  result: CommandCenterResult;
  query: string;
  backdrop: SurfaceBackdrop;
}) {
  if (result.kind === "file") {
    return (
      <View style={styles.rowContent}>
        <View style={styles.rowMain}>
          <View style={styles.iconSlot} testID="command-center-file-icon">
            <MaterialFileIcon fileName={result.title} size={16} />
          </View>
          <Text style={styles.fileLine} numberOfLines={1} testID="command-center-file-line">
            <QueryHighlightedText
              query={query}
              text={result.title}
              style={styles.fileName}
              testID="command-center-file-name"
            />
            {result.subtitle ? (
              <Text style={styles.filePath} testID="command-center-file-path">
                {" "}
                <QueryHighlightedText query={query} text={result.subtitle} />
              </Text>
            ) : null}
          </Text>
        </View>
      </View>
    );
  }
  if (result.kind === "agent") {
    return <AgentResultContent result={result} query={query} backdrop={backdrop} />;
  }
  if (result.kind === "workspace") {
    const key = result.id.slice("workspace:".length);
    return (
      <View style={styles.rowContent} testID={`command-center-workspace-${key}`}>
        <View style={styles.rowMain}>
          {/* Decorative: the fallback icon's initial must not prefix the row's accessible name. */}
          <View style={styles.iconSlot}>
            <WorkspaceResultIcon result={result} backdrop={backdrop} />
          </View>
          <View style={styles.textContent}>
            <QueryHighlightedText
              query={query}
              text={result.title}
              style={styles.title}
              numberOfLines={1}
            />
            <SubtitleWithTimestamp
              query={query}
              subtitle={result.subtitle}
              activityAt={result.activityAt}
              testID="command-center-workspace-subtitle"
            />
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
            <QueryHighlightedText
              query={query}
              text={presentation.title}
              style={styles.title}
              numberOfLines={1}
            />
            {presentation.subtitle ? (
              <QueryHighlightedText
                query={query}
                text={presentation.subtitle}
                style={styles.subtitle}
                numberOfLines={1}
              />
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
              <QueryHighlightedText
                query={query}
                text={part}
                style={
                  index === presentation.path.length - 1 ? styles.title : styles.breadcrumbGroup
                }
                numberOfLines={1}
              />
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
  const style = useMemo(() => [styles.section, { height: row.height }], [row.height]);
  return (
    <View style={style}>
      {row.divider ? <View style={styles.sectionDivider} /> : null}
      {row.title ? <Text style={styles.sectionLabel}>{row.title}</Text> : null}
    </View>
  );
}

export function CommandCenter() {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const listRef = useRef<FlatList<CommandCenterListRow>>(null);
  const bottomSheetListRef = useRef<BottomSheetFlatListMethods>(null);
  const bottomSheetInputRef = useRef<EditingTextInputHandle>(null);
  const [interaction] = useState(() =>
    createCommandCenterInteraction((offset) => {
      const list = listRef.current ?? bottomSheetListRef.current;
      list?.scrollToOffset({ offset, animated: false });
    }),
  );
  const state = useCommandCenterState(
    isCompact ? COMMAND_CENTER_LIST_METRICS.compact : COMMAND_CENTER_LIST_METRICS.desktop,
    interaction,
  );
  const showBottomSheet = isCompact && isNative;
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && state.open && !showBottomSheet);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: state.open,
    isEnabled: showBottomSheet,
    onClose: state.close,
  });

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      interaction.layout(event.nativeEvent.layout.height);
    },
    [interaction],
  );
  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      interaction.scrolled(event.nativeEvent.contentOffset.y);
    },
    [interaction],
  );
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
          height={item.height}
          query={state.query}
          active={item.result.id === state.activeId}
          onSelect={state.select}
        />
      ),
    [state.activeId, state.query, state.select],
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
    onScrollBeginDrag: interaction.beginManualScroll,
    onTouchStart: interaction.beginManualScroll,
    ...(isWeb
      ? {
          onWheel: interaction.beginManualScroll,
          onMouseDown: interaction.beginManualScroll,
        }
      : {}),
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
        backdropOpacity={0.45}
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
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.5)" },
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
  // Sections and rows take their height from list-metrics; these styles only place content in it.
  section: { justifyContent: "flex-end" },
  sectionLabel: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: COMMAND_CENTER_SECTION_GAP,
    fontSize: theme.fontSize.sm,
    lineHeight: COMMAND_CENTER_LINE_HEIGHT.sectionLabel,
    color: theme.colors.foregroundMuted,
  },
  sectionDivider: {
    height: 1,
    marginVertical: COMMAND_CENTER_SECTION_GAP,
    backgroundColor: theme.colors.border,
  },
  row: { paddingHorizontal: theme.spacing[4], justifyContent: "center" },
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
    lineHeight: COMMAND_CENTER_LINE_HEIGHT.title,
    flexShrink: 1,
  },
  fileLine: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: COMMAND_CENTER_LINE_HEIGHT.singleLine,
  },
  fileName: { color: theme.colors.foreground },
  filePath: { color: theme.colors.foregroundMuted },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: COMMAND_CENTER_LINE_HEIGHT.subtitle,
  },
  subtitleLine: { flexDirection: "row", minWidth: 0 },
  subtitleText: { flexShrink: 1, minWidth: 0 },
  iconSlot: {
    width: 16,
    height: COMMAND_CENTER_LINE_HEIGHT.singleLine,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: { fontSize: 9 },
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
    lineHeight: COMMAND_CENTER_LINE_HEIGHT.singleLine,
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
}));
