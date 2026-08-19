import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  Pencil,
  RotateCw,
  Globe,
  FileDiff,
  FolderTree,
  GitPullRequest,
  Maximize2,
  Minimize2,
  Plus,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { useRouter, type Href } from "expo-router";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type {
  DraggableListDragHandleProps,
  DraggableRenderItemInfo,
} from "@/components/draggable-list.types";
import { isNative, isWeb } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import { retainWorkspaceTabMeasuredWidth } from "@/screens/workspace/workspace-tab-layout";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildWorkspaceDesktopTabActions,
  type WorkspaceDesktopTabActions,
  type WorkspaceTabMenuEntry,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { RenderProfile } from "@/utils/render-profiler";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";

const DROPDOWN_WIDTH = 220;
const DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH = 36;
// Chip geometry. `layoutMetrics` measures tabs from these same numbers, so a chip that changes
// shape without changing them mis-measures and drops the row into the overflow-scroll fallback at
// the wrong width. Keep them together.
// Tabs and the adjacent New Tab trigger are one control family. Keep their outer box and corner
// token identical; only their horizontal sizing differs (content-width chip versus square icon).
const TAB_CHIP_HORIZONTAL_PADDING = 8;
const TAB_CHIP_GAP = 4;
const TAB_ROW_PADDING_HORIZONTAL = 4;
const TAB_ICON_WIDTH = 14;
const TAB_CONTENT_GAP = 4;
const TAB_DROP_INDICATOR_WIDTH = 4;
const TAB_MIN_WIDTH = 96;
const TAB_MAX_WIDTH = 160;
const TAB_CLOSE_BUTTON_RESERVED_WIDTH = 0;
const TAB_LABEL_LAYOUT_ALLOWANCE = 4;
const TAB_SCROLL_SHADE_WIDTH = 24;
const TAB_SCROLL_EDGE_EPSILON = 1;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);

function WorkspaceTabScrollShadeSvg({ side, color }: { side: "left" | "right"; color: string }) {
  const gradientId = `workspace-tab-scroll-shade-${side}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient
          id={gradientId}
          x1={side === "left" ? "100%" : "0%"}
          y1="0%"
          x2={side === "left" ? "0%" : "100%"}
          y2="0%"
        >
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedWorkspaceTabScrollShadeSvg = withUnistyles(WorkspaceTabScrollShadeSvg);
const tabScrollShadeColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });

function WorkspaceTabScrollShades({
  visible,
  leftStyle,
  rightStyle,
}: {
  visible: boolean;
  leftStyle: AnimatedStyle<{ opacity: number }>;
  rightStyle: AnimatedStyle<{ opacity: number }>;
}) {
  if (!visible) return null;

  return (
    <>
      <Animated.View
        pointerEvents="none"
        testID="workspace-tabs-scroll-shade-left"
        style={[styles.tabScrollShade, styles.tabScrollShadeLeft, leftStyle]}
      >
        <ThemedWorkspaceTabScrollShadeSvg side="left" uniProps={tabScrollShadeColorMapping} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        testID="workspace-tabs-scroll-shade-right"
        style={[styles.tabScrollShade, styles.tabScrollShadeRight, rightStyle]}
      >
        <ThemedWorkspaceTabScrollShadeSvg side="right" uniProps={tabScrollShadeColorMapping} />
      </Animated.View>
    </>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedSquarePen = withUnistyles(SquarePen);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const ThemedPlus = withUnistyles(Plus);
const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedMinimize2 = withUnistyles(Minimize2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const AGENT_ICON = <ThemedSquarePen size={14} uniProps={mutedColorMapping} />;
const TERMINAL_ICON = <ThemedSquareTerminal size={14} uniProps={mutedColorMapping} />;
const BROWSER_ICON = <ThemedGlobe size={14} uniProps={mutedColorMapping} />;
const CHANGES_ICON = <ThemedFileDiff size={14} uniProps={mutedColorMapping} />;
const FILES_ICON = <ThemedFolderTree size={14} uniProps={mutedColorMapping} />;
const PULL_REQUEST_ICON = <ThemedGitPullRequest size={14} uniProps={mutedColorMapping} />;

const CHANGES_TARGET = { kind: "working_diff" } as const;
const FILES_TARGET = { kind: "files" } as const;
const PULL_REQUEST_TARGET = { kind: "pull_request" } as const;

function inlineAddActionButtonStyle({
  hovered,
  pressed,
  open = false,
}: PressableStateCallbackType & { open?: boolean }) {
  return [
    styles.inlineAddActionButton,
    (hovered || pressed || open) && styles.newTabActionButtonHovered,
  ];
}

function updateMeasuredWidth(
  setWidth: React.Dispatch<React.SetStateAction<number>>,
  event: LayoutChangeEvent,
) {
  const nextWidth = Math.round(event.nativeEvent.layout.width);
  setWidth((current) => retainWorkspaceTabMeasuredWidth(current, nextWidth));
}

function TabLabelMeasurement({
  tabKey,
  label,
  onMeasure,
}: {
  tabKey: string;
  label: string;
  onMeasure: (tabKey: string, label: string, event: LayoutChangeEvent) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(tabKey, label, event),
    [label, onMeasure, tabKey],
  );

  return (
    <Text
      style={[styles.tabLabel, styles.tabLabelMeasurement]}
      numberOfLines={1}
      onLayout={handleLayout}
    >
      {label}
    </Text>
  );
}

interface TerminalProfileMenuItemProps {
  profile: { id: string; name: string; command: string; args?: string[]; icon?: string };
  disabled?: boolean;
  onLaunch: (profile: TerminalProfile) => void;
}

function TerminalProfileMenuItem({ profile, disabled, onLaunch }: TerminalProfileMenuItemProps) {
  const leading = useMemo(
    () => <TerminalProfileIcon iconKey={getTerminalProfileIcon(profile)} />,
    [profile],
  );
  const handleSelect = useCallback(() => onLaunch(profile), [onLaunch, profile]);

  return (
    <DropdownMenuItem leading={leading} disabled={disabled} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

interface TabTargetLauncherOptions {
  normalizedServerId: string;
  onCreateAgentTab: () => void;
  onCreateTerminal: () => void;
  onCreateBrowser: () => void;
  onOpenChanges: () => void;
  onOpenFiles: () => void;
  onOpenPullRequest: () => void;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
}

interface WorkspaceNewTabButtonProps extends TabTargetLauncherOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcutKeys: ShortcutKey[][] | null;
  onEditProfiles: () => void;
  showCreateBrowserTab: boolean;
  terminalDisabled: boolean;
  isGit: boolean;
  showPullRequest: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}

function WorkspaceNewTabButton({
  open,
  onOpenChange,
  shortcutKeys,
  onCreateAgentTab,
  onCreateTerminal,
  onCreateBrowser,
  onOpenChanges,
  onOpenFiles,
  onOpenPullRequest,
  onCreateTerminalWithProfile,
  onEditProfiles,
  normalizedServerId,
  showCreateBrowserTab,
  terminalDisabled,
  isGit,
  showPullRequest,
  onLayout,
}: WorkspaceNewTabButtonProps) {
  const { t } = useTranslation();
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );
  const agentKeys = useShortcutKeys("workspace-tab-target-agent");
  const terminalKeys = useShortcutKeys("workspace-terminal-new");
  const browserKeys = useShortcutKeys("workspace-tab-target-browser");
  const changesKeys = useShortcutKeys("workspace-tab-target-changes");
  const filesKeys = useShortcutKeys("workspace-tab-target-files");
  const tooltipText = t("workspace.tabs.actions.newTab");
  const agentShortcut = useMemo(
    () => (agentKeys ? <Shortcut chord={agentKeys} /> : undefined),
    [agentKeys],
  );
  const terminalShortcut = useMemo(
    () => (terminalKeys ? <Shortcut chord={terminalKeys} /> : undefined),
    [terminalKeys],
  );
  const browserShortcut = useMemo(
    () => (browserKeys ? <Shortcut chord={browserKeys} /> : undefined),
    [browserKeys],
  );
  const changesShortcut = useMemo(
    () => (changesKeys ? <Shortcut chord={changesKeys} /> : undefined),
    [changesKeys],
  );
  const filesShortcut = useMemo(
    () => (filesKeys ? <Shortcut chord={filesKeys} /> : undefined),
    [filesKeys],
  );

  return (
    <View style={styles.inlineAddButton} onLayout={onLayout}>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <DropdownMenuTrigger
              testID="workspace-new-tab-menu-trigger"
              accessibilityRole="button"
              accessibilityLabel={tooltipText}
              style={inlineAddActionButtonStyle}
            >
              <ThemedPlus size={14} uniProps={extraMutedColorMapping} />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <View style={styles.newTabTooltipRow}>
              <Text style={styles.newTabTooltipText}>{tooltipText}</Text>
              {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
            </View>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="start" offset={4} minWidth={200}>
          <DropdownMenuItem
            testID="workspace-new-tab-menu-agent"
            leading={AGENT_ICON}
            trailing={agentShortcut}
            onSelect={onCreateAgentTab}
          >
            {t("workspace.tabs.fallback.agent")}
          </DropdownMenuItem>
          <DropdownMenuItem
            testID="workspace-new-tab-menu-terminal"
            leading={TERMINAL_ICON}
            disabled={terminalDisabled}
            trailing={terminalShortcut}
            onSelect={terminalDisabled ? undefined : onCreateTerminal}
          >
            {t("workspace.tabs.fallback.terminal")}
          </DropdownMenuItem>
          {showCreateBrowserTab ? (
            <DropdownMenuItem
              testID="workspace-new-tab-menu-browser"
              leading={BROWSER_ICON}
              trailing={browserShortcut}
              onSelect={onCreateBrowser}
            >
              {t("workspace.tabs.fallback.browser")}
            </DropdownMenuItem>
          ) : null}
          {isGit ? (
            <DropdownMenuItem
              testID="workspace-new-tab-menu-changes"
              leading={CHANGES_ICON}
              trailing={changesShortcut}
              onSelect={onOpenChanges}
            >
              {t("workspace.tabs.actions.changes")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            testID="workspace-new-tab-menu-files"
            leading={FILES_ICON}
            trailing={filesShortcut}
            onSelect={onOpenFiles}
          >
            {t("workspace.tabs.actions.files")}
          </DropdownMenuItem>
          {showPullRequest ? (
            <DropdownMenuItem
              testID="workspace-new-tab-menu-pull-request"
              leading={PULL_REQUEST_ICON}
              onSelect={onOpenPullRequest}
            >
              {t("workspace.tabs.actions.pullRequest")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
          {profiles.map((profile) => (
            <TerminalProfileMenuItem
              key={profile.id}
              profile={profile}
              disabled={terminalDisabled}
              onLaunch={onCreateTerminalWithProfile}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem testID="workspace-new-tab-menu-edit-profiles" onSelect={onEditProfiles}>
            {t("workspace.tabs.actions.editTerminalProfiles")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function WorkspacePaneMaximizeButton({
  visible,
  maximized,
  onPress,
  onLayout,
}: {
  visible: boolean;
  maximized: boolean;
  onPress?: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const maximizePaneKeys = useShortcutKeys("workspace-explorer-maximize");
  if (!visible || !onPress) {
    return null;
  }
  const label = t(
    maximized ? "workspace.tabs.actions.restorePane" : "workspace.tabs.actions.maximizePane",
  );

  return (
    <View style={[styles.inlineAddButton, styles.paneMaximizeButtonSlot]} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID={maximized ? "workspace-restore-pane" : "workspace-maximize-pane"}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={inlineAddActionButtonStyle}
        >
          {maximized ? (
            <ThemedMinimize2 size={14} uniProps={extraMutedColorMapping} />
          ) : (
            <ThemedMaximize2 size={14} uniProps={extraMutedColorMapping} />
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.newTabTooltipRow}>
            <Text style={styles.newTabTooltipText}>{label}</Text>
            {maximizePaneKeys ? <Shortcut chord={maximizePaneKeys} /> : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function WorkspaceExitFocusModeButton({
  visible,
  onPress,
  onLayout,
}: {
  visible: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const focusModeKeys = useShortcutKeys("toggle-focus");
  if (!visible) {
    return null;
  }

  return (
    <View style={styles.exitFocusModeSlot} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID="workspace-exit-focus-mode"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.tabs.actions.exitFocusMode")}
          style={inlineAddActionButtonStyle}
        >
          <ThemedX size={14} uniProps={mutedColorMapping} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.newTabTooltipRow}>
            <Text style={styles.newTabTooltipText}>
              {t("workspace.tabs.actions.exitFocusMode")}
            </Text>
            {focusModeKeys ? (
              <Shortcut chord={focusModeKeys} style={styles.newTabTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function resolvePaneMaximizeReservedWidth(visible: boolean, measuredWidth: number): number {
  return visible ? measuredWidth : 0;
}

function TabContextMenuItem({
  entry,
}: {
  entry: Extract<WorkspaceTabMenuEntry, { kind: "item" }>;
}) {
  const leading = useMemo(() => {
    switch (entry.icon) {
      case "copy":
        return <ThemedCopy size={16} uniProps={mutedColorMapping} />;
      case "rotate-cw":
        return <ThemedRotateCw size={16} uniProps={mutedColorMapping} />;
      case "arrow-left-to-line":
        return <ThemedArrowLeftToLine size={16} uniProps={mutedColorMapping} />;
      case "arrow-right-to-line":
        return <ThemedArrowRightToLine size={16} uniProps={mutedColorMapping} />;
      case "copy-x":
        return <ThemedCopyX size={16} uniProps={mutedColorMapping} />;
      case "pencil":
        return <ThemedPencil size={16} uniProps={mutedColorMapping} />;
      case "x":
        return <ThemedX size={16} uniProps={mutedColorMapping} />;
      default:
        return undefined;
    }
  }, [entry.icon]);
  const trailing = useMemo(
    () => (entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined),
    [entry.hint],
  );
  return (
    <ContextMenuItem
      testID={entry.testID}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
      tooltip={entry.tooltip}
      leading={leading}
      trailing={trailing}
    >
      {entry.label}
    </ContextMenuItem>
  );
}

function tabKeyExtractor(tab: WorkspaceDesktopTabRowItem) {
  return `${tab.tab.key}:${tab.tab.kind}`;
}

export interface WorkspaceDesktopTabRowItem {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
}

interface ResolvedWorkspaceDesktopTabRowItem extends WorkspaceDesktopTabRowItem {
  presentation: WorkspaceTabPresentation;
}

interface WorkspaceTabLabel {
  key: string;
  label: string;
}

interface WorkspaceTabLabelMeasurement {
  label: string;
  width: number;
}

interface WorkspaceTabTrackSnapshot {
  signature: string;
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
  labels: WorkspaceTabLabel[];
  labelWidths: number[];
}

function workspaceTabLabelSignature(labels: WorkspaceTabLabel[]): string {
  return JSON.stringify(labels);
}

function completeWorkspaceTabLabelWidths(
  labels: WorkspaceTabLabel[],
  measurements: Map<string, WorkspaceTabLabelMeasurement>,
): number[] | null {
  const widths: number[] = [];
  for (const { key, label } of labels) {
    const measurement = measurements.get(key);
    if (!measurement || measurement.label !== label || measurement.width <= 0) {
      return null;
    }
    widths.push(measurement.width + TAB_LABEL_LAYOUT_ALLOWANCE);
  }
  return widths;
}

function sameWidths(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index]);
}

interface WorkspaceDesktopTabsRowProps {
  paneId?: string;
  isFocused?: boolean;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onCreateDraftTab: (input: { paneId?: string }) => void;
  onCreateTerminalTab: (input: { paneId?: string; profile?: TerminalProfile }) => void;
  onCreateBrowserTab: (input: { paneId?: string }) => void;
  showCreateBrowserTab?: boolean;
  disableCreateTerminal?: boolean;
  isWaitingOnTerminalReadiness?: boolean;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showPaneMaximizeAction?: boolean;
  paneMaximized?: boolean;
  onTogglePaneMaximized?: () => void;
  focusModeEnabled: boolean;
  onExitFocusMode: () => void;
}

interface ResolvedWorkspaceDesktopTabsRowProps extends Omit<WorkspaceDesktopTabsRowProps, "tabs"> {
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
}

interface WorkspaceDesktopTabPresentationSlotProps {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}

const EMPTY_RESOLVED_TAB_ROWS: ResolvedWorkspaceDesktopTabRowItem[] = [];

function WorkspaceDesktopTabPresentationSlot({
  tab,
  serverId,
  workspaceId,
  onResolve,
}: WorkspaceDesktopTabPresentationSlotProps) {
  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <WorkspaceDesktopTabPresentationCommit
          tabKey={tab.key}
          presentation={presentation}
          onResolve={onResolve}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
}

function WorkspaceDesktopTabPresentationCommit({
  tabKey,
  presentation,
  onResolve,
}: {
  tabKey: string;
  presentation: WorkspaceTabPresentation;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}) {
  useLayoutEffect(() => {
    onResolve(tabKey, presentation);
  }, [onResolve, presentation, tabKey]);
  return null;
}

function getFallbackTabLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
    newAgent: string;
    setup: string;
    terminal: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.setup;
  }
  if (tab.target.kind === "terminal") {
    return labels.terminal;
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").findLast(Boolean) ?? tab.target.path;
  }
  if (tab.target.kind === "working_diff") {
    return labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  return labels.agent;
}

function useMiddleClickClose(onClose: () => void) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (isNative) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;

    function handleAuxClick(event: MouseEvent) {
      if (event.button === 1) {
        event.preventDefault();
        onClose();
      }
    }

    node.addEventListener("auxclick", handleAuxClick);
    return () => node.removeEventListener("auxclick", handleAuxClick);
  }, [onClose]);

  return ref;
}

/** The chip fill the running-status ring has to knock out of. Mirrors `styles.tab*` exactly. */
function resolveChipBackdrop({
  isActiveFocused,
  isFilled,
}: {
  isActiveFocused: boolean;
  isFilled: boolean;
}): SurfaceBackdrop {
  if (isActiveFocused) return "surface2";
  return isFilled ? "surface1" : "surface0";
}

function TabHandleContent({
  presentation,
  isHighlighted,
  showLabel,
  backdrop,
  tabLabelSkeletonStyle,
  tabLabelStyle,
}: {
  presentation: WorkspaceTabPresentation;
  isHighlighted: boolean;
  showLabel: boolean;
  backdrop: SurfaceBackdrop;
  tabLabelSkeletonStyle: React.ComponentProps<typeof View>["style"];
  tabLabelStyle: React.ComponentProps<typeof Text>["style"];
}) {
  const tabHandleDataSet = useMemo(
    () => ({ statusBucket: presentation.statusBucket ?? "none" }),
    [presentation.statusBucket],
  );

  return (
    <View style={styles.tabHandle} dataSet={tabHandleDataSet}>
      <View style={styles.tabIcon}>
        <WorkspaceTabIcon presentation={presentation} active={isHighlighted} backdrop={backdrop} />
      </View>
      {showLabel && presentation.titleState === "loading" ? (
        <View style={tabLabelSkeletonStyle} />
      ) : null}
      {showLabel && presentation.titleState !== "loading" ? (
        <Text style={tabLabelStyle} selectable={false} numberOfLines={1} ellipsizeMode="tail">
          {presentation.label}
        </Text>
      ) : null}
    </View>
  );
}

function TabChip({
  tab,
  isActive,
  isDragging,
  isFocused,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  isCloseHovered,
  isClosingTab,
  presentation,
  tooltipLabel,
  resolvedTab,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isDragging: boolean;
  isFocused: boolean;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  presentation: WorkspaceTabPresentation;
  tooltipLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { t } = useTranslation();
  const { closeButtonTestId, contextMenuTestId, menuEntries } = resolvedTab;
  const middleClickRef = useMiddleClickClose(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
  );
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  // An active tab in a pane that does not have focus stays legible but quiet: it keeps the fill of
  // a hovered chip and the muted label, so only one chip in the window reads as the live one.
  const isActiveFocused = isActive && isFocused;
  const isHovered = hovered || isCloseHovered;
  const isHighlighted = isActiveFocused || isHovered;
  const chipBackdrop: SurfaceBackdrop = resolveChipBackdrop({
    isActiveFocused,
    isFilled: isActive || isHovered,
  });
  const showCloseControl = showCloseButton && (isHovered || isNative || isCompact || isClosingTab);
  const closeButtonDragBlockers = isWeb
    ? ({
        onPointerDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
        onMouseDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
      } as const)
    : undefined;
  const tabMenuTriggerBlockers = useMemo(() => {
    if (!isNative) return undefined;
    const stop = (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
    };
    return { onPointerDown: stop, onMouseDown: stop, onPressIn: stop, onPress: stop } as const;
  }, []);

  const tabChipStyle = useCallback(
    () => [
      styles.tab,
      isActiveFocused && styles.tabActive,
      isActive && !isFocused && styles.tabActiveUnfocused,
      !isActive && isHovered && styles.tabHovered,
      isWeb && isDragging && ({ cursor: "grabbing" } as object),
      {
        minWidth: resolvedTabWidth,
        width: resolvedTabWidth,
        maxWidth: resolvedTabWidth,
      },
    ],
    [isActive, isActiveFocused, isDragging, isFocused, isHovered, resolvedTabWidth],
  );

  const handleTabPointerEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleTabPointerLeave = useCallback(() => {
    setHovered(false);
  }, []);

  const handleNavigateTab = useCallback(() => {
    onNavigateTab(tab.tabId);
  }, [onNavigateTab, tab.tabId]);

  const handleCloseButtonPressIn = useCallback((event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
  }, []);

  const handleCloseButtonHoverIn = useCallback(() => {
    setHoveredCloseTabKey(tab.key);
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonHoverOut = useCallback(() => {
    setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonPress = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      void onCloseTab(tab.tabId);
    },
    [onCloseTab, tab.tabId],
  );

  const tabAccessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const tabLabelSkeletonStyle = styles.tabLabelSkeleton;
  const tabLabelStyle = useMemo(
    () => [styles.tabLabel, isHighlighted && styles.tabLabelActive],
    [isHighlighted],
  );

  return (
    <View
      ref={middleClickRef}
      style={styles.tabHoverFrame}
      onPointerEnter={handleTabPointerEnter}
      onPointerLeave={handleTabPointerLeave}
    >
      <ContextMenu key={tab.key}>
        <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              enabledOnMobile={false}
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              testID={`workspace-tab-${buildDeterministicWorkspaceTabId(tab.target)}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as unknown as undefined}
              style={tabChipStyle}
              onPressIn={handleNavigateTab}
              onPress={handleNavigateTab}
              accessibilityRole="button"
              accessibilityLabel={tooltipLabel}
              accessibilityState={tabAccessibilityState}
              aria-selected={isActive}
            >
              <TabHandleContent
                presentation={presentation}
                isHighlighted={isHighlighted}
                showLabel={showLabel}
                backdrop={chipBackdrop}
                tabLabelSkeletonStyle={tabLabelSkeletonStyle}
                tabLabelStyle={tabLabelStyle}
              />
              {presentation.modified ? (
                <View
                  style={styles.tabModifiedIndicator}
                  accessibilityLabel={t("workspace.tabs.modified")}
                  testID={`workspace-tab-modified-${buildDeterministicWorkspaceTabId(tab.target)}`}
                >
                  <View style={styles.tabModifiedDot} />
                </View>
              ) : null}
              {isNative ? (
                <MobileTabTrailingAccessory
                  menuTestIDBase={contextMenuTestId}
                  presentationLabel={tooltipLabel}
                  menuEntries={menuEntries}
                  triggerProps={tabMenuTriggerBlockers}
                />
              ) : null}
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            offset={8}
            maxWidth={720}
            testID={`workspace-tab-tooltip-${buildDeterministicWorkspaceTabId(tab.target)}`}
          >
            {tab.target.kind === "agent" ? (
              <View style={styles.tooltipAgentRow}>
                <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
                <Text style={styles.tooltipAgentId}>{tab.target.agentId.slice(0, 7)}</Text>
              </View>
            ) : (
              <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
            )}
          </TooltipContent>
        </Tooltip>

        {showCloseButton ? (
          <View
            pointerEvents={showCloseControl ? "box-none" : "none"}
            style={[
              styles.tabTrailingOverlay,
              showCloseControl ? styles.tabTrailingOverlayShown : styles.tabTrailingOverlayHidden,
            ]}
          >
            <TrailingActionScrim backdrop={chipBackdrop} />
            <Pressable
              {...(closeButtonDragBlockers as object | undefined)}
              testID={closeButtonTestId}
              disabled={isClosingTab}
              onPressIn={handleCloseButtonPressIn}
              onHoverIn={handleCloseButtonHoverIn}
              onHoverOut={handleCloseButtonHoverOut}
              onPress={handleCloseButtonPress}
              style={styles.tabCloseButton}
            >
              {({ hovered: closeHovered, pressed }) => {
                const highlighted = closeHovered || pressed;
                if (isClosingTab) {
                  return (
                    <ThemedLoadingSpinner
                      size={12}
                      uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                    />
                  );
                }
                return (
                  <ThemedX
                    size={12}
                    uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                  />
                );
              }}
            </Pressable>
          </View>
        ) : null}

        <ContextMenuContent align="start" width={DROPDOWN_WIDTH} testID={contextMenuTestId}>
          {menuEntries.map((entry) =>
            entry.kind === "separator" ? (
              <ContextMenuSeparator key={entry.key} />
            ) : (
              <TabContextMenuItem key={entry.key} entry={entry} />
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

export function WorkspaceDesktopTabsRow(props: WorkspaceDesktopTabsRowProps) {
  const [presentations, setPresentations] = useState(
    () => new Map<string, WorkspaceTabPresentation>(),
  );
  const handlePresentation = useCallback(
    (tabKey: string, presentation: WorkspaceTabPresentation) => {
      setPresentations((current) => {
        if (current.get(tabKey) === presentation) {
          return current;
        }
        const next = new Map(current);
        next.set(tabKey, presentation);
        return next;
      });
    },
    [],
  );
  const currentTabKeys = useMemo(
    () => new Set(props.tabs.map((item) => item.tab.key)),
    [props.tabs],
  );
  useEffect(() => {
    setPresentations((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabKeys]);
  const resolvedTabs = useMemo(
    () =>
      props.tabs.flatMap((item) => {
        const presentation = presentations.get(item.tab.key);
        return presentation ? [{ ...item, presentation }] : [];
      }),
    [presentations, props.tabs],
  );

  return (
    <>
      <ResolvedWorkspaceDesktopTabsRow {...props} tabs={resolvedTabs} />
      {props.tabs.map(({ tab }) => (
        <WorkspaceDesktopTabPresentationSlot
          key={`${tab.key}:${tab.kind}`}
          tab={tab}
          serverId={props.normalizedServerId}
          workspaceId={props.normalizedWorkspaceId}
          onResolve={handlePresentation}
        />
      ))}
    </>
  );
}

function ResolvedWorkspaceDesktopTabsRow({
  paneId,
  isFocused = false,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  onCreateBrowserTab,
  showCreateBrowserTab = false,
  disableCreateTerminal = false,
  isWaitingOnTerminalReadiness = false,
  onReorderTabs,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showPaneMaximizeAction = false,
  paneMaximized = false,
  onTogglePaneMaximized,
  focusModeEnabled,
  onExitFocusMode,
}: ResolvedWorkspaceDesktopTabsRowProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const newTabKeys = useShortcutKeys("workspace-tab-new");
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const [inlineAddButtonWidth, setInlineAddButtonWidth] = useState<number>(0);
  const [paneMaximizeButtonWidth, setPaneMaximizeButtonWidth] = useState<number>(0);
  const [exitFocusModeWidth, setExitFocusModeWidth] = useState<number>(0);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const tabScrollOffset = useSharedValue(0);
  const tabScrollViewportWidth = useSharedValue(0);
  const tabScrollContentWidth = useSharedValue(0);
  const [labelMeasurements, setLabelMeasurements] = useState(
    () => new Map<string, WorkspaceTabLabelMeasurement>(),
  );
  const [trackSnapshot, setTrackSnapshot] = useState<WorkspaceTabTrackSnapshot | null>(null);
  const workspaceRoot = useWorkspaceDirectory(normalizedServerId, normalizedWorkspaceId) ?? "";
  const checkoutStatus = useCheckoutStatusQuery({
    serverId: normalizedServerId,
    cwd: workspaceRoot,
  });
  const isGit = checkoutStatus.status?.isGit === true;
  const showPullRequest = isGit;
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const focusPane = useWorkspaceLayoutStore((state) => state.focusPane);
  const openTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);

  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsContainerWidth, event);
  }, []);

  const handleInlineAddButtonLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setInlineAddButtonWidth, event);
  }, []);

  const handleExitFocusModeLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setExitFocusModeWidth, event);
  }, []);

  const handlePaneMaximizeButtonLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setPaneMaximizeButtonWidth, event);
  }, []);

  const handleTabScrollLayout = useCallback(
    (event: LayoutChangeEvent) => {
      tabScrollViewportWidth.value = event.nativeEvent.layout.width;
    },
    [tabScrollViewportWidth],
  );

  const handleTabScrollContentSizeChange = useCallback(
    (width: number) => {
      tabScrollContentWidth.value = width;
    },
    [tabScrollContentWidth],
  );

  const handleTabScroll = useAnimatedScrollHandler((event) => {
    tabScrollOffset.value = event.contentOffset.x;
    tabScrollViewportWidth.value = event.layoutMeasurement.width;
    tabScrollContentWidth.value = event.contentSize.width;
  });

  const leftTabScrollShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(tabScrollOffset.value > TAB_SCROLL_EDGE_EPSILON),
  }));
  const rightTabScrollShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(
      tabScrollOffset.value + tabScrollViewportWidth.value <
        tabScrollContentWidth.value - TAB_SCROLL_EDGE_EPSILON,
    ),
  }));

  const layoutMetrics = useMemo(
    () => ({
      rowHorizontalInset: 0,
      actionsReservedWidth: Math.max(
        0,
        (inlineAddButtonWidth || DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH) +
          (focusModeEnabled ? exitFocusModeWidth : 0) +
          resolvePaneMaximizeReservedWidth(showPaneMaximizeAction, paneMaximizeButtonWidth),
      ),
      rowPaddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
      tabGap: TAB_CHIP_GAP,
      minTabWidth: TAB_MIN_WIDTH,
      maxTabWidth: TAB_MAX_WIDTH,
      tabIconWidth: TAB_ICON_WIDTH,
      tabContentGap: TAB_CONTENT_GAP,
      tabHorizontalPadding: TAB_CHIP_HORIZONTAL_PADDING,
      closeButtonWidth: TAB_CLOSE_BUTTON_RESERVED_WIDTH,
    }),
    [
      exitFocusModeWidth,
      focusModeEnabled,
      inlineAddButtonWidth,
      paneMaximizeButtonWidth,
      showPaneMaximizeAction,
    ],
  );

  const fallbackTabLabels = useMemo(
    () => ({
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
    }),
    [t],
  );
  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () =>
      tabs.map((tab) => {
        const label =
          tab.presentation.titleState === "loading"
            ? getFallbackTabLabel(tab.tab, fallbackTabLabels)
            : tab.presentation.label;
        return { key: tab.tab.key, label };
      }),
    [fallbackTabLabels, tabs],
  );
  const tabLabelSignature = useMemo(() => workspaceTabLabelSignature(tabLabels), [tabLabels]);
  const currentTabLabelKeys = useMemo(() => new Set(tabLabels.map(({ key }) => key)), [tabLabels]);
  useEffect(() => {
    setLabelMeasurements((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabLabelKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabLabelKeys]);
  const publishMeasuredTrack = useCallback(() => {
    if (tabsContainerWidth <= 0) {
      return;
    }
    const labelWidths = completeWorkspaceTabLabelWidths(tabLabels, labelMeasurements);
    if (!labelWidths) {
      return;
    }

    setTrackSnapshot((current) => {
      if (
        current?.signature === tabLabelSignature &&
        sameWidths(current.labelWidths, labelWidths)
      ) {
        return current;
      }
      return {
        signature: tabLabelSignature,
        tabs,
        labels: tabLabels,
        labelWidths,
      };
    });
  }, [labelMeasurements, tabLabelSignature, tabLabels, tabs, tabsContainerWidth]);

  useLayoutEffect(() => {
    publishMeasuredTrack();
  }, [publishMeasuredTrack]);

  const handleTabLabelLayout = useCallback(
    (key: string, label: string, event: LayoutChangeEvent) => {
      const width = Math.ceil(event.nativeEvent.layout.width);
      if (width <= 0) {
        return;
      }
      setLabelMeasurements((current) => {
        const measurement = current.get(key);
        if (measurement?.label === label && measurement.width === width) {
          return current;
        }
        const next = new Map(current);
        next.set(key, { label, width });
        return next;
      });
    },
    [],
  );

  const displayedTabs = useMemo(() => {
    if (!trackSnapshot) {
      return EMPTY_RESOLVED_TAB_ROWS;
    }
    const currentTabs = new Map(
      tabs.map((tab, index) => [tab.tab.key, { tab, label: tabLabels[index]?.label }]),
    );
    return trackSnapshot.tabs.map((snapshotTab, index) => {
      const current = currentTabs.get(snapshotTab.tab.key);
      return current?.label === trackSnapshot.labels[index]?.label ? current.tab : snapshotTab;
    });
  }, [tabLabels, tabs, trackSnapshot]);

  const { layout } = useWorkspaceTabLayout({
    tabLabelWidths: trackSnapshot?.labelWidths ?? [],
    viewportWidthOverride: tabsContainerWidth > 0 ? tabsContainerWidth : null,
    metrics: layoutMetrics,
  });

  const handleDragEnd = useCallback(
    (nextTabs: ResolvedWorkspaceDesktopTabRowItem[]) => {
      onReorderTabs(nextTabs.map((tab) => tab.tab));
    },
    [onReorderTabs],
  );

  const getTabDragData = useMemo(() => {
    if (!paneId) return undefined;
    return (tab: ResolvedWorkspaceDesktopTabRowItem) => ({
      kind: "workspace-tab" as const,
      paneId,
      tabId: tab.tab.tabId,
    });
  }, [paneId]);

  const handleCreateAgentTab = useCallback(() => {
    onCreateDraftTab({ paneId });
  }, [onCreateDraftTab, paneId]);

  const handleCreateTerminal = useCallback(() => {
    onCreateTerminalTab({ paneId });
  }, [onCreateTerminalTab, paneId]);

  const handleCreateTerminalWithProfile = useCallback(
    (profile: TerminalProfile) => {
      onCreateTerminalTab({ paneId, profile });
    },
    [onCreateTerminalTab, paneId],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);

  const handleCreateBrowser = useCallback(() => {
    onCreateBrowserTab({ paneId });
  }, [onCreateBrowserTab, paneId]);

  const openPanelTarget = useCallback(
    (target: { kind: "working_diff" } | { kind: "files" } | { kind: "pull_request" }) => {
      if (!workspaceKey) {
        return;
      }
      if (paneId) {
        focusPane(workspaceKey, paneId);
      }
      openTabFocused(workspaceKey, target);
    },
    [focusPane, openTabFocused, paneId, workspaceKey],
  );
  const handleOpenChanges = useCallback(() => openPanelTarget(CHANGES_TARGET), [openPanelTarget]);
  const handleOpenFiles = useCallback(() => openPanelTarget(FILES_TARGET), [openPanelTarget]);
  const handleOpenPullRequest = useCallback(
    () => openPanelTarget(PULL_REQUEST_TARGET),
    [openPanelTarget],
  );

  const terminalDisabled = disableCreateTerminal || isWaitingOnTerminalReadiness;

  useEffect(() => {
    if (!isFocused) {
      setNewTabMenuOpen(false);
    }
  }, [isFocused]);

  const handleNewTabKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!isFocused) return false;
      if (action.id === "workspace.tab.menu.open") {
        setNewTabMenuOpen(true);
        return true;
      }
      switch (action.id) {
        case "workspace.tab.target.agent":
          setNewTabMenuOpen(false);
          handleCreateAgentTab();
          return true;
        case "workspace.tab.target.browser":
          if (!showCreateBrowserTab) return true;
          setNewTabMenuOpen(false);
          handleCreateBrowser();
          return true;
        case "workspace.tab.target.changes":
          if (!isGit) return true;
          setNewTabMenuOpen(false);
          handleOpenChanges();
          return true;
        case "workspace.tab.target.files":
          setNewTabMenuOpen(false);
          handleOpenFiles();
          return true;
        default:
          return false;
      }
    },
    [
      handleCreateAgentTab,
      handleCreateBrowser,
      handleOpenChanges,
      handleOpenFiles,
      isFocused,
      isGit,
      showCreateBrowserTab,
    ],
  );

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab-menu",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      paneId,
    }),
    actions: [
      "workspace.tab.menu.open",
      "workspace.tab.target.agent",
      "workspace.tab.target.browser",
      "workspace.tab.target.changes",
      "workspace.tab.target.files",
    ],
    enabled: isFocused,
    priority: 200,
    handle: handleNewTabKeyboardAction,
  });

  const renderTab = useCallback(
    ({
      item,
      index,
      dragHandleProps,
      isActive,
    }: DraggableRenderItemInfo<ResolvedWorkspaceDesktopTabRowItem>) => {
      const shouldShowCloseButton = layout.closeButtonPolicy === "all";
      const layoutItem = layout.items[index] ?? null;
      const resolvedTabWidth = layoutItem?.width ?? 150;
      const showLabel = layoutItem?.showLabel ?? true;
      const showDropIndicatorBefore = activeDragTabId !== null && tabDropPreviewIndex === index;
      const showDropIndicatorAfter =
        activeDragTabId !== null &&
        tabDropPreviewIndex === displayedTabs.length &&
        index === displayedTabs.length - 1;

      return (
        <ResolvedDesktopTabChip
          key={`${item.tab.key}:${item.tab.kind}`}
          item={item}
          isFocused={isFocused}
          isDragging={isActive}
          index={index}
          tabCount={displayedTabs.length}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          resolvedTabWidth={resolvedTabWidth}
          showLabel={showLabel}
          showCloseButton={shouldShowCloseButton}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          labels={tabMenuLabels}
          dragHandleProps={dragHandleProps}
          showDropIndicatorBefore={showDropIndicatorBefore}
          showDropIndicatorAfter={showDropIndicatorAfter}
        />
      );
    },
    [
      activeDragTabId,
      isFocused,
      layout.closeButtonPolicy,
      layout.items,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      onNavigateTab,
      onReloadAgent,
      onRenameTab,
      setHoveredCloseTabKey,
      tabMenuLabels,
      tabDropPreviewIndex,
      displayedTabs.length,
    ],
  );

  const tabsScrollStyle = useMemo(
    () => [
      styles.tabsScroll,
      layout.requiresHorizontalScrollFallback
        ? styles.tabsScrollOverflow
        : styles.tabsScrollFitContent,
    ],
    [layout.requiresHorizontalScrollFallback],
  );

  const row = (
    <View
      style={styles.tabsContainer}
      testID="workspace-tabs-row"
      onLayout={handleTabsContainerLayout}
    >
      <View
        style={styles.tabLabelMeasurements}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {tabLabels.map(({ key, label }) => (
          <TabLabelMeasurement
            key={`${key}:${label}`}
            tabKey={key}
            label={label}
            onMeasure={handleTabLabelLayout}
          />
        ))}
      </View>
      <WorkspaceExitFocusModeButton
        visible={focusModeEnabled}
        onPress={onExitFocusMode}
        onLayout={handleExitFocusModeLayout}
      />
      <View style={styles.tabsScrollContainer}>
        <Animated.ScrollView
          horizontal
          scrollEnabled={layout.requiresHorizontalScrollFallback}
          testID="workspace-tabs-scroll"
          style={tabsScrollStyle}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
          onLayout={handleTabScrollLayout}
          onContentSizeChange={handleTabScrollContentSizeChange}
          onScroll={handleTabScroll}
          scrollEventThrottle={16}
        >
          <SortableInlineList
            data={displayedTabs}
            keyExtractor={tabKeyExtractor}
            useDragHandle
            disabled={!externalDndContext && displayedTabs.length < 2}
            onDragEnd={handleDragEnd}
            externalDndContext={externalDndContext}
            activeId={activeDragTabId}
            getItemData={getTabDragData}
            renderItem={renderTab}
          />
          {!layout.requiresHorizontalScrollFallback ? (
            <WorkspaceNewTabButton
              open={newTabMenuOpen}
              onOpenChange={setNewTabMenuOpen}
              shortcutKeys={newTabKeys}
              onCreateAgentTab={handleCreateAgentTab}
              onCreateTerminal={handleCreateTerminal}
              onCreateBrowser={handleCreateBrowser}
              onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
              onOpenChanges={handleOpenChanges}
              onOpenFiles={handleOpenFiles}
              onOpenPullRequest={handleOpenPullRequest}
              onEditProfiles={handleEditProfiles}
              normalizedServerId={normalizedServerId}
              showCreateBrowserTab={showCreateBrowserTab}
              terminalDisabled={terminalDisabled}
              isGit={isGit}
              showPullRequest={showPullRequest}
              onLayout={handleInlineAddButtonLayout}
            />
          ) : null}
        </Animated.ScrollView>
        <WorkspaceTabScrollShades
          visible={layout.requiresHorizontalScrollFallback}
          leftStyle={leftTabScrollShadeStyle}
          rightStyle={rightTabScrollShadeStyle}
        />
      </View>
      {layout.requiresHorizontalScrollFallback ? (
        <WorkspaceNewTabButton
          open={newTabMenuOpen}
          onOpenChange={setNewTabMenuOpen}
          shortcutKeys={newTabKeys}
          onCreateAgentTab={handleCreateAgentTab}
          onCreateTerminal={handleCreateTerminal}
          onCreateBrowser={handleCreateBrowser}
          onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
          onOpenChanges={handleOpenChanges}
          onOpenFiles={handleOpenFiles}
          onOpenPullRequest={handleOpenPullRequest}
          onEditProfiles={handleEditProfiles}
          normalizedServerId={normalizedServerId}
          showCreateBrowserTab={showCreateBrowserTab}
          terminalDisabled={terminalDisabled}
          isGit={isGit}
          showPullRequest={showPullRequest}
          onLayout={handleInlineAddButtonLayout}
        />
      ) : null}
      <WorkspacePaneMaximizeButton
        visible={showPaneMaximizeAction}
        maximized={paneMaximized}
        onPress={onTogglePaneMaximized}
        onLayout={handlePaneMaximizeButtonLayout}
      />
    </View>
  );

  return <RenderProfile id="WorkspaceDesktopTabsRow">{row}</RenderProfile>;
}
function ResolvedDesktopTabChip({
  item,
  isFocused,
  isDragging,
  index,
  tabCount,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  labels,
  dragHandleProps,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
}: {
  item: ResolvedWorkspaceDesktopTabRowItem;
  isFocused: boolean;
  isDragging: boolean;
  index: number;
  tabCount: number;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  labels: WorkspaceTabMenuLabels;
  dragHandleProps: DraggableListDragHandleProps | undefined;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
}) {
  const { t } = useTranslation();
  const presentation = item.presentation;
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onCopyTerminalId,
        onCopyFilePath,
        onReloadAgent,
        onRenameTab,
        onCloseTab,
        onCloseTabsToLeft,
        onCloseTabsToRight,
        onCloseOtherTabs,
        labels,
      }),
    [
      index,
      item.tab,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      labels,
      onReloadAgent,
      onRenameTab,
      tabCount,
    ],
  );

  const tooltipLabel =
    presentation.titleState === "loading"
      ? t("workspace.tabs.loadingAgentTitle")
      : presentation.tooltip;

  return (
    <View style={styles.tabSlot}>
      {showDropIndicatorBefore ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
      ) : null}
      <TabChip
        tab={item.tab}
        isActive={item.isActive}
        isDragging={isDragging}
        isFocused={isFocused}
        resolvedTabWidth={resolvedTabWidth}
        showLabel={showLabel}
        showCloseButton={showCloseButton}
        isCloseHovered={item.isCloseHovered}
        isClosingTab={item.isClosingTab}
        presentation={presentation}
        tooltipLabel={tooltipLabel}
        resolvedTab={resolvedTab}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        dragHandleProps={dragHandleProps}
      />
      {showDropIndicatorAfter ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorAfter]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  tabsScroll: {
    minWidth: 0,
  },
  tabsScrollContainer: {
    minWidth: 0,
    flex: 1,
    alignSelf: "stretch",
  },
  tabsScrollFitContent: {
    flex: 1,
  },
  tabsScrollOverflow: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
  },
  tabScrollShade: {
    position: "absolute",
    top: 0,
    bottom: 1,
    width: TAB_SCROLL_SHADE_WIDTH,
  },
  tabScrollShadeLeft: {
    left: 0,
  },
  tabScrollShadeRight: {
    right: 0,
  },
  exitFocusModeSlot: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  inlineAddButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  paneMaximizeButtonSlot: {
    // Keep the glyph centered in its hit target while placing that glyph on the trailing rail.
    marginRight: theme.spacing[2],
  },
  tab: {
    height: buttonControlHeight.xs,
    paddingHorizontal: TAB_CHIP_HORIZONTAL_PADDING,
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  tabHovered: {
    backgroundColor: theme.colors.surface1,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabActiveUnfocused: {
    backgroundColor: theme.colors.surface1,
  },
  tabHoverFrame: {
    position: "relative",
  },
  tabSlot: {
    position: "relative",
    overflow: "visible",
    marginHorizontal: TAB_CHIP_GAP / 2,
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  tabIcon: {
    width: TAB_ICON_WIDTH,
    height: TAB_ICON_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // The chip box stops at the slot's padding box, so the gap between two chips runs from
  // -TAB_CHIP_GAP to 0. Centre a TAB_DROP_INDICATOR_WIDTH pill in it.
  tabDropIndicator: {
    position: "absolute",
    top: theme.spacing[0.5],
    bottom: theme.spacing[0.5],
    width: TAB_DROP_INDICATOR_WIDTH,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  tabDropIndicatorBefore: {
    left: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabDropIndicatorAfter: {
    right: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  tabLabelMeasurements: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
    alignItems: "flex-start",
    pointerEvents: "none",
  },
  tabLabelMeasurement: {
    flexShrink: 0,
  },
  tabLabelSkeleton: {
    width: 96,
    maxWidth: "100%",
    flexShrink: 1,
    minWidth: 0,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.9,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabTrailingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 48,
    borderTopRightRadius: theme.borderRadius.md,
    borderBottomRightRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    overflow: "hidden",
  },
  tabTrailingOverlayShown: {
    opacity: 1,
  },
  tabTrailingOverlayHidden: {
    opacity: 0,
  },
  tabCloseButton: {
    position: "absolute",
    right: 4,
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  tabModifiedIndicator: {
    position: "absolute",
    right: 8,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  tabModifiedDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  inlineAddActionButton: {
    width: buttonControlHeight.xs,
    height: buttonControlHeight.xs,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {},
  tooltipAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
