import {
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
} from "react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, Home, Plus, Settings } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetFlatListMethods,
} from "@gorhom/bottom-sheet";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { Shortcut } from "@/components/ui/shortcut";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { getIsElectronRuntime, useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { getBindingIdForAction, getDefaultKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { chordStringToShortcutKeys } from "@/keyboard/shortcut-string";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import { focusWithRetries } from "@/utils/web-focus";
import { buildOpenProjectRoute, buildSettingsRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIconProps } from "./contributions";
import { useCommandCenterActions, useCommandCenterContributions } from "./provider";
import {
  buildContributionSections,
  moveActiveResultId,
  preserveActiveResultId,
  projectCommandCenterRows,
  type CommandCenterAgentResult,
  type CommandCenterListRow,
  type CommandCenterResult,
  type CommandCenterResultSection,
  type CommandCenterWorkspaceResult,
} from "./results";

const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
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
const ThemedPlus = withUnistyles(Plus, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedSettings = withUnistyles(Settings, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedHome = withUnistyles(Home, (theme) => ({ color: theme.colors.foregroundMuted }));
const COMMAND_CENTER_SNAP_POINTS = ["60%", "90%"];
const KEYBOARD_SHOULD_PERSIST_TAPS = "always" as const;

function PlusIcon({ size }: CommandCenterIconProps) {
  return <ThemedPlus size={size} strokeWidth={2.4} />;
}

function SettingsIcon({ size }: CommandCenterIconProps) {
  return <ThemedSettings size={size} strokeWidth={2.2} />;
}

function HomeIcon({ size }: CommandCenterIconProps) {
  return <ThemedHome size={size} strokeWidth={2.2} />;
}

function resolveActionShortcutKeys(
  actionId: string | undefined,
  overrides: Record<string, string>,
): ShortcutKey[][] | undefined {
  if (!actionId) return undefined;
  const platform = {
    isMac: getShortcutOs() === "mac",
    isDesktop: getIsElectronRuntime(),
  };
  const bindingId = getBindingIdForAction(actionId, platform);
  if (!bindingId) return undefined;
  const override = overrides[bindingId];
  if (override) return chordStringToShortcutKeys(override);
  const defaultKeys = getDefaultKeysForAction(actionId, platform);
  return defaultKeys ? [defaultKeys] : undefined;
}

export function CommandCenterRootActions() {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const openAddProject = useOpenAddProject();
  const settingsRoute = useMemo<Href>(() => buildSettingsRoute(), []);
  const homeRoute = useMemo<Href>(() => buildOpenProjectRoute(), []);
  const actions = useMemo<CommandCenterContribution[]>(
    () => [
      {
        id: "new-agent",
        group: "actions",
        groupRank: 0,
        rank: 0,
        keywords: ["open", "project", "folder", "workspace", "repo"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          openAddProject();
        },
        presentation: {
          kind: "action",
          title: t("shell.commandCenter.addProject"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: PlusIcon,
          shortcutKeys: resolveActionShortcutKeys("new-agent", overrides),
        },
      },
      {
        id: "home",
        group: "actions",
        groupRank: 0,
        rank: 1,
        keywords: ["home", "start", "import", "session", "pair", "device", "providers"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(homeRoute);
        },
        presentation: {
          kind: "action",
          title: t("shell.commandCenter.home"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: HomeIcon,
        },
      },
      {
        id: "settings",
        group: "actions",
        groupRank: 0,
        rank: 2,
        keywords: ["settings", "preferences", "config", "configuration"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(settingsRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.actions.settings"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: SettingsIcon,
        },
      },
    ],
    [homeRoute, openAddProject, overrides, settingsRoute, t],
  );

  useCommandCenterActions({ sourceId: "root", enabled: true, actions });
  return null;
}

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

function useBuiltInSections(open: boolean, query: string): CommandCenterResultSection[] {
  const { t } = useTranslation();
  const { agents } = useAggregatedAgents();
  const { projects } = useProjects({ enabled: open });
  const showAgentHost = useHosts().length > 1;

  return useMemo(() => {
    if (!open) return [];
    const allWorkspaces: CommandCenterWorkspaceResult[] = [];
    for (const project of projects) {
      for (const host of project.hosts) {
        for (const workspace of host.workspaces) {
          if (workspace.archivingAt) continue;
          const title = workspace.title ?? workspace.name;
          const subtitle = workspace.currentBranch
            ? `${host.serverName} · ${workspace.currentBranch}`
            : host.serverName;
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
    const workspaces = allWorkspaces.filter((workspace) =>
      matchesQuery(workspace.searchText, query),
    );
    const agentResults = agents
      .map<CommandCenterAgentResult>((agent) => {
        const title = agent.title || t("shell.commandCenter.newAgent");
        const workspaceTitle = agent.workspaceId
          ? workspaceTitleByKey.get(`${agent.serverId}:${agent.workspaceId}`)
          : undefined;
        const location = workspaceTitle ?? shortenPath(agent.cwd);
        const subtitle = [
          showAgentHost ? agent.serverLabel : null,
          location,
          formatTimeAgo(agent.lastActivityAt),
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · ");
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
      .sort((left, right) => sortAgents(left.agent, right.agent));
    return [
      {
        id: "workspaces",
        rank: 2,
        title: t("shell.commandCenter.workspaces"),
        results: workspaces,
      },
      { id: "agents", rank: 3, title: t("shell.commandCenter.agents"), results: agentResults },
    ];
  }, [agents, open, projects, query, showAgentHost, t]);
}

interface CommandCenterState {
  open: boolean;
  query: string;
  setQuery(query: string): void;
  activeId: string | null;
  rows: readonly CommandCenterListRow[];
  results: readonly CommandCenterResult[];
  rowIndexByResultId: ReadonlyMap<string, number>;
  offsets: readonly number[];
  inputRef: React.RefObject<TextInput | null>;
  close(): void;
  select(result: CommandCenterResult): void;
  key(key: string): boolean;
}

function useCommandCenterState(): CommandCenterState {
  const open = useKeyboardShortcutsStore((state) => state.commandCenterOpen);
  const setOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const snapshot = useCommandCenterContributions();
  const inputRef = useRef<TextInput>(null);
  const previousOpenRef = useRef(open);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const builtInSections = useBuiltInSections(open, query);
  const contributionSections = useMemo(
    () => buildContributionSections(snapshot.contributions, query),
    [query, snapshot.contributions],
  );
  const projection = useMemo(
    () => projectCommandCenterRows([...contributionSections, ...builtInSections]),
    [builtInSections, contributionSections],
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
    [close, open, projection.selectableResults, resolvedActiveId, select],
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
  }, [open]);

  useEffect(() => {
    if (!open || !isWeb) return;
    const listener = (event: KeyboardEvent) => {
      if (key(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [key, open]);

  return {
    open,
    query,
    setQuery,
    activeId: resolvedActiveId,
    rows: projection.rows,
    results: projection.selectableResults,
    rowIndexByResultId: projection.rowIndexByResultId,
    offsets: projection.offsets,
    inputRef,
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
    <Pressable style={style} onPress={press}>
      <ResultContent result={result} />
    </Pressable>
  );
});

function ResultContent({ result }: { result: CommandCenterResult }) {
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
            <Text style={styles.subtitle} numberOfLines={1}>
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
    <View style={styles.rowContent} testID={presentation.testId}>
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
  const listRef = useRef<FlatList<CommandCenterListRow>>(null);
  const bottomSheetListRef = useRef<BottomSheetFlatListMethods>(null);
  const bottomSheetInputRef = useRef<React.ElementRef<typeof BottomSheetTextInput>>(null);
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible: state.open,
    isEnabled: showBottomSheet,
    onClose: state.close,
  });

  useEffect(() => {
    if (!state.open || !state.activeId) return;
    const index = state.rowIndexByResultId.get(state.activeId);
    if (index === undefined) return;
    const ref = showBottomSheet ? bottomSheetListRef.current : listRef.current;
    ref?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [showBottomSheet, state.activeId, state.open, state.rowIndexByResultId]);
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
    () => <Text style={styles.emptyText}>{t("shell.commandCenter.noMatches")}</Text>,
    [t],
  );
  const commonListProps = {
    data: state.rows,
    renderItem,
    keyExtractor,
    getItemLayout,
    ListEmptyComponent: empty,
    keyboardShouldPersistTaps: KEYBOARD_SHOULD_PERSIST_TAPS,
    showsVerticalScrollIndicator: false,
    initialNumToRender: 12,
    maxToRenderPerBatch: 10,
    windowSize: 5,
  };
  const keyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => state.key(key),
    [state],
  );
  const submit = useCallback(() => state.key("Enter"), [state]);
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
        <View style={styles.bottomSheetHeader}>
          <ThemedBottomSheetTextInput
            testID="command-center-input"
            ref={bottomSheetInputRef}
            value={state.query}
            onChangeText={state.setQuery}
            onKeyPress={keyPress}
            onSubmitEditing={submit}
            placeholder={t("shell.commandCenter.placeholder")}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        </View>
        <BottomSheetFlatList ref={bottomSheetListRef} {...commonListProps} />
      </IsolatedBottomSheetModal>
    );
  }
  if (!state.open) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={state.close}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={state.close} />
        <View testID="command-center-panel" style={styles.panel}>
          <View style={styles.header}>
            <ThemedTextInput
              testID="command-center-input"
              ref={state.inputRef}
              value={state.query}
              onChangeText={state.setQuery}
              placeholder={t("shell.commandCenter.placeholder")}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
          </View>
          <FlatList ref={listRef} style={styles.results} {...commonListProps} />
        </View>
      </View>
    </Modal>
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
  results: { flexGrow: 0 },
  sectionLabel: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    flexShrink: 1,
  },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs, lineHeight: 18 },
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
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    flexShrink: 0,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sheetBackground: { backgroundColor: theme.colors.surface0 },
  sheetHandle: { backgroundColor: theme.colors.palette.zinc[600] },
  titledSection: { height: 32, justifyContent: "flex-end" },
  dividedSection: { height: 49, justifyContent: "flex-end" },
  dividerSection: { height: 17, justifyContent: "flex-end" },
}));
