import { useBrowserStore } from "@/desktop/browser/store";
import { getIsElectron } from "@/constants/platform";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import { WorkspaceNewTabMenuContent } from "@/screens/workspace/workspace-new-tab-menu";
import { WorkspaceHistoryMenu } from "@/screens/workspace/workspace-history-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
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
  type ScrollView as NativeScrollView,
} from "react-native";
import {
  ChevronDown,
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  Pencil,
  RotateCw,
  Columns2,
  Rows2,
  Ellipsis,
  Maximize,
  Minimize,
  Plus,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
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
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { Shortcut } from "@/components/ui/shortcut";
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
import type { PaneHost } from "@/panels/panel-manifest";
import type { WorkspaceTabLaunchPurpose } from "@/workspace-tabs/launcher";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { RenderProfile } from "@/utils/render-profiler";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { formatCompactTimeAgoAsProse } from "@/utils/time";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  paneContentToolbarTrailingPadding,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import {
  HorizontalScrollBoundaryShades,
  useHorizontalScrollBoundary,
} from "@/components/ui/horizontal-scroll-boundary";
import { useSessionStore } from "@/stores/session-store";
import { SyncedLoader } from "@/components/synced-loader";

const DROPDOWN_WIDTH = 220;
const DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH = 36;
const PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING = 2;
const PANE_SPLIT_ACTIONS_OUTER_MARGIN =
  paneContentToolbarTrailingPadding(false, "glyph") - PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING;
const PANE_SPLIT_ACTIONS_RESERVED_WIDTH =
  smallIconButtonChromeFrameSize(false) +
  PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING * 2 +
  PANE_SPLIT_ACTIONS_OUTER_MARGIN;
const PANE_MAXIMIZE_ACTION_RESERVED_WIDTH = smallIconButtonChromeFrameSize(false) + 1;
// Tab geometry. `layoutMetrics` measures tabs from these same numbers, so a tab that changes
// shape without changing them mis-measures and drops the row into the overflow-scroll fallback at
// the wrong width. Keep them together.
// The adjacent New Tab trigger keeps the shared control-height box; tabs fill the row's inner
// height (TAB_ROW_INNER_HEIGHT) so the active underline sits flush against the row's bottom edge
// instead of floating above it. Only their horizontal sizing differs.
// Agent and provider_subagent tabs show their title alone: their icon allocation lives in the
// per-tab label widths instead of the shared chrome, so files, terminals and browsers keep icons
// while conversations gain the space.
const TAB_CHIP_HORIZONTAL_PADDING = 8;
const TAB_CHIP_GAP = 4;
const TAB_ROW_PADDING_HORIZONTAL = 4;
const TAB_ICON_WIDTH = 14;
const TAB_CONTENT_GAP = 4;
const TAB_DROP_INDICATOR_WIDTH = 4;
const TAB_MODIFIED_DOT_SIZE = 8;
const TAB_MIN_WIDTH = 180;
const TAB_MAX_WIDTH = 320;
const TAB_ACTIVE_UNDERLINE_HEIGHT = 2;
// The tab row is the secondary header minus its 1px bottom border; tabs fill that inner box.
const TAB_ROW_INNER_HEIGHT = WORKSPACE_SECONDARY_HEADER_HEIGHT - 1;
const TAB_CLOSE_BUTTON_RESERVED_WIDTH = 0;
const TAB_LABEL_LAYOUT_ALLOWANCE = 4;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const ThemedX = withUnistyles(X);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCopy = withUnistyles(Copy);

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedRows2 = withUnistyles(Rows2);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedMaximize = withUnistyles(Maximize);
const ThemedMinimize = withUnistyles(Minimize);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

function updateMeasuredWidth(
  setWidth: React.Dispatch<React.SetStateAction<number>>,
  event: LayoutChangeEvent,
) {
  const nextWidth = Math.round(event.nativeEvent.layout.width);
  setWidth((current) => retainWorkspaceTabMeasuredWidth(current, nextWidth));
}

function normalizeAgentTooltipTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function AgentTabTooltipBody({
  serverId,
  agentId,
  title,
}: {
  serverId: string;
  agentId: string;
  title: string;
}) {
  const lastActivityAt = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
    return state.agentLastActivity.get(agentId) ?? agent?.lastActivityAt ?? null;
  });
  const compactActivity = useCompactTimeAgo(lastActivityAt);
  const activity = formatCompactTimeAgoAsProse(compactActivity);

  return (
    <View style={styles.tooltipAgentContent}>
      <Text style={styles.agentTooltipTitle} numberOfLines={1} ellipsizeMode="tail">
        {title}
      </Text>
      <View style={styles.tooltipAgentMetadata}>
        <Text style={styles.tooltipAgentId}>{agentId.slice(0, 7)}</Text>
        {activity ? (
          <>
            <Text style={styles.tooltipAgentSeparator}>·</Text>
            <Text style={styles.tooltipAgentActivity}>{activity}</Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

function TabLabelMeasurement({
  tabKey,
  label,
  requiresAttention,
  onMeasure,
}: {
  tabKey: string;
  label: string;
  requiresAttention: boolean;
  onMeasure: (
    tabKey: string,
    label: string,
    requiresAttention: boolean,
    event: LayoutChangeEvent,
  ) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(tabKey, label, requiresAttention, event),
    [label, onMeasure, requiresAttention, tabKey],
  );

  return (
    <Text
      style={[
        styles.tabLabel,
        styles.tabLabelMeasurement,
        requiresAttention && styles.tabLabelUnread,
      ]}
      numberOfLines={1}
      onLayout={handleLayout}
    >
      {label}
    </Text>
  );
}

type PanePanelKinds = readonly WorkspaceTabDescriptor["kind"][];

interface WorkspaceNewTabButtonProps {
  variant?: "workspace" | "browser";
  panePanelKinds: PanePanelKinds;
  host: PaneHost;
  launchPurpose: WorkspaceTabLaunchPurpose;
  serverId: string;
  paneId?: string;
  shortcutKeys: ShortcutKey[][] | null;
  placement: "inline" | "toolbar";
  onCreateNewTab: () => void;
}

function WorkspaceNewTabButton({
  variant = "workspace",
  panePanelKinds,
  host,
  launchPurpose,
  serverId,
  paneId,
  shortcutKeys,
  placement,
  onCreateNewTab,
}: WorkspaceNewTabButtonProps) {
  const { t } = useTranslation();
  const tooltipText = t(
    variant === "browser" ? "workspace.browser.newTab" : "workspace.tabs.actions.newTab",
  );
  const button =
    host === "main" || variant === "browser" ? (
      <ToolbarButton
        label={tooltipText}
        shortcut={shortcutKeys}
        testID="workspace-new-tab-button"
        style={placement === "inline" ? styles.inlineNewTabButton : undefined}
        onPress={onCreateNewTab}
      >
        <ThemedPlus size={14} uniProps={extraMutedColorMapping} />
      </ToolbarButton>
    ) : (
      <DropdownMenu>
        <ToolbarButton
          kind="menu"
          label={tooltipText}
          shortcut={shortcutKeys}
          testID="workspace-new-tab-button"
          style={placement === "inline" ? styles.inlineNewTabButton : undefined}
        >
          <ThemedPlus size={14} uniProps={extraMutedColorMapping} />
        </ToolbarButton>
        <WorkspaceNewTabMenuContent
          serverId={serverId}
          purpose={launchPurpose}
          host={host}
          panePanelKinds={panePanelKinds}
          paneId={paneId}
        />
      </DropdownMenu>
    );

  return placement === "inline" ? <View style={styles.inlineAddButton}>{button}</View> : button;
}

function WorkspacePaneToolbarActions({
  variant,
  panePanelKinds,
  host,
  launchPurpose,
  showNewTabButton,
  showSplitActions,
  showMaximizeAction,
  paneMaximized,
  newTabShortcutKeys,
  serverId,
  paneId,
  onCreateNewTab,
  onSplitRight,
  onSplitDown,
  onTogglePaneMaximized,
}: {
  variant?: "workspace" | "browser";
  panePanelKinds: PanePanelKinds;
  host: PaneHost;
  launchPurpose: WorkspaceTabLaunchPurpose;
  showNewTabButton: boolean;
  showSplitActions: boolean;
  showMaximizeAction: boolean;
  paneMaximized: boolean;
  newTabShortcutKeys: ShortcutKey[][] | null;
  serverId: string;
  paneId?: string;
  onCreateNewTab: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onTogglePaneMaximized?: () => void;
}) {
  const { t } = useTranslation();
  const splitRightKeys = useShortcutKeys("workspace-pane-split-right");
  const splitDownKeys = useShortcutKeys("workspace-pane-split-down");
  const splitActionsVisible = showSplitActions && Boolean(onSplitRight && onSplitDown);
  const splitRightLeading = useMemo(
    () => <ThemedColumns2 size={14} uniProps={extraMutedColorMapping} />,
    [],
  );
  const splitDownLeading = useMemo(
    () => <ThemedRows2 size={14} uniProps={extraMutedColorMapping} />,
    [],
  );
  const splitRightTrailing = useMemo(
    () => (splitRightKeys ? <Shortcut chord={splitRightKeys} /> : null),
    [splitRightKeys],
  );
  const splitDownTrailing = useMemo(
    () => (splitDownKeys ? <Shortcut chord={splitDownKeys} /> : null),
    [splitDownKeys],
  );
  const maximizeActionVisible = showMaximizeAction && Boolean(onTogglePaneMaximized);
  if (!showNewTabButton && !splitActionsVisible && !maximizeActionVisible) return null;

  return (
    <ToolbarControls style={styles.paneSplitActions}>
      {showNewTabButton ? (
        <WorkspaceNewTabButton
          variant={variant}
          panePanelKinds={panePanelKinds}
          host={host}
          launchPurpose={launchPurpose}
          placement="toolbar"
          serverId={serverId}
          paneId={paneId}
          shortcutKeys={newTabShortcutKeys}
          onCreateNewTab={onCreateNewTab}
        />
      ) : null}
      {maximizeActionVisible && onTogglePaneMaximized ? (
        <ToolbarButton
          label={t(
            paneMaximized
              ? "workspace.tabs.actions.restorePane"
              : "workspace.tabs.actions.maximizePane",
          )}
          selected={paneMaximized}
          testID={paneMaximized ? "workspace-restore-pane" : "workspace-maximize-pane"}
          onPress={onTogglePaneMaximized}
        >
          {paneMaximized ? (
            <ThemedMinimize size={14} uniProps={extraMutedColorMapping} />
          ) : (
            <ThemedMaximize size={14} uniProps={extraMutedColorMapping} />
          )}
        </ToolbarButton>
      ) : null}
      {splitActionsVisible && onSplitRight && onSplitDown ? (
        <DropdownMenu>
          <ToolbarButton
            kind="menu"
            label={t("workspace.git.actions.moreActions")}
            testID="workspace-split-pane-menu"
          >
            <ThemedEllipsis size={14} uniProps={extraMutedColorMapping} />
          </ToolbarButton>
          <DropdownMenuContent
            side="bottom"
            align="end"
            offset={4}
            width={220}
            testID="workspace-split-pane-menu-content"
          >
            <DropdownMenuItem
              leading={splitRightLeading}
              trailing={splitRightTrailing}
              testID="workspace-split-pane-right"
              onSelect={onSplitRight}
            >
              {t("workspace.tabs.actions.splitRight")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={splitDownLeading}
              trailing={splitDownTrailing}
              testID="workspace-split-pane-down"
              onSelect={onSplitDown}
            >
              {t("workspace.tabs.actions.splitDown")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </ToolbarControls>
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
      <ToolbarButton
        label={t("workspace.tabs.actions.exitFocusMode")}
        shortcut={focusModeKeys}
        testID="workspace-exit-focus-mode"
        onPress={onPress}
      >
        <ThemedX size={14} uniProps={mutedColorMapping} />
      </ToolbarButton>
    </View>
  );
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
  requiresAttention: boolean;
  modified: boolean;
  /** Tabs whose icon is part of the rendered row; its width rides along in the label width. */
  icon: boolean;
}

interface WorkspaceTabLabelMeasurement {
  label: string;
  requiresAttention: boolean;
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
  for (const { key, label, modified, icon, requiresAttention } of labels) {
    const measurement = measurements.get(key);
    if (
      !measurement ||
      measurement.label !== label ||
      measurement.requiresAttention !== requiresAttention ||
      measurement.width <= 0
    ) {
      return null;
    }
    // The modified dot sits in the content row, so a modified tab needs that much more width
    // before its label starts truncating. An iconified tab carries its icon and the content gap
    // the same way — the shared chrome width only covers what every tab renders.
    const modifiedAllowance = modified ? TAB_CONTENT_GAP + TAB_MODIFIED_DOT_SIZE : 0;
    const iconAllowance = icon ? TAB_ICON_WIDTH + TAB_CONTENT_GAP : 0;
    widths.push(measurement.width + TAB_LABEL_LAYOUT_ALLOWANCE + modifiedAllowance + iconAllowance);
  }
  return widths;
}

function sameWidths(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index]);
}

export interface WorkspaceDesktopTabsRowProps {
  variant?: "workspace" | "browser";
  host?: PaneHost;
  launchPurpose?: WorkspaceTabLaunchPurpose;
  paneId?: string;
  isFocused?: boolean;
  ownsKeyboardShortcuts?: boolean;
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
  onCreateNewTab: (input: { paneId?: string; kind?: "browser" }) => void;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showPaneSplitActions?: boolean;
  showPaneMaximizeAction?: boolean;
  paneMaximized?: boolean;
  onTogglePaneMaximized?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
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
    newTab: string;
    newAgent: string;
    setup: string;
    terminal: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
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
  if (tab.target.kind === "working_diff" || tab.target.kind === "changes_tree") {
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

/**
 * Flat tabs: only a hover carries a fill, so the backdrop the running-status ring and the
 * close-button scrim knock out of is the surface the tab actually sits on.
 */
function resolveChipBackdrop({ isFilled }: { isFilled: boolean }): SurfaceBackdrop {
  return isFilled ? "surface1" : "surface0";
}

function TabHandleContent({
  presentation,
  isHighlighted,
  showLabel,
  backdrop,
  tabLabelSkeletonStyle,
  tabLabelStyle,
  modifiedTestId,
  runningTestId,
}: {
  presentation: WorkspaceTabPresentation;
  isHighlighted: boolean;
  showLabel: boolean;
  backdrop: SurfaceBackdrop;
  tabLabelSkeletonStyle: React.ComponentProps<typeof View>["style"];
  tabLabelStyle: React.ComponentProps<typeof Text>["style"];
  modifiedTestId: string;
  runningTestId: string;
}) {
  const { t } = useTranslation();
  const tabHandleDataSet = useMemo(
    () => ({ statusBucket: presentation.statusBucket ?? "none" }),
    [presentation.statusBucket],
  );
  // Conversations read as their title alone; files, terminals and browsers keep their icon.
  const showIcon = presentation.kind !== "agent" && presentation.kind !== "provider_subagent";
  const showRunningLoader = !showIcon && presentation.statusBucket === "running";

  return (
    <View style={styles.tabHandle} dataSet={tabHandleDataSet}>
      {showRunningLoader ? (
        <View
          style={styles.tabIcon}
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
          testID={runningTestId}
        >
          <ThemedSyncedLoader
            size={14}
            uniProps={isHighlighted ? foregroundColorMapping : mutedColorMapping}
          />
        </View>
      ) : null}
      {showIcon ? (
        <View style={styles.tabIcon}>
          <WorkspaceTabIcon
            presentation={presentation}
            active={isHighlighted}
            backdrop={backdrop}
          />
        </View>
      ) : null}
      {showLabel && presentation.titleState === "loading" ? (
        <View style={tabLabelSkeletonStyle} />
      ) : null}
      {showLabel && presentation.titleState !== "loading" ? (
        <Text style={tabLabelStyle} selectable={false} numberOfLines={1} ellipsizeMode="tail">
          {presentation.label}
        </Text>
      ) : null}
      {/* The dot is a laid-out sibling of the label, not an overlay, so a truncated label ends
          before it instead of running underneath it. */}
      {presentation.modified ? (
        <View
          style={styles.tabModifiedDot}
          accessibilityLabel={t("workspace.tabs.modified")}
          testID={modifiedTestId}
        />
      ) : null}
    </View>
  );
}

function showTabCloseControl(
  variant: "workspace" | "browser",
  hovered: boolean,
  compact: boolean,
  closing: boolean,
) {
  return variant === "browser" || hovered || isNative || compact || closing;
}

function TabChip({
  variant,
  serverId,
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
  accessibilityLabel,
  resolvedTab,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  variant: "workspace" | "browser";
  serverId: string;
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
  accessibilityLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { closeButtonTestId, contextMenuTestId, menuEntries } = resolvedTab;
  const { t } = useTranslation();
  const middleClickRef = useMiddleClickClose(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
  );
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  // Flat tabs mark the active one with a 2px underline and a foreground label instead of a fill;
  // a hovered tab keeps a quiet surface so pointer aim still reads.
  const isActiveFocused = isActive && isFocused;
  const isHovered = hovered || isCloseHovered;
  const isHighlighted = isActiveFocused || isHovered;
  const chipBackdrop: SurfaceBackdrop = resolveChipBackdrop({ isFilled: isHovered });
  const showCloseControl =
    showCloseButton && showTabCloseControl(variant, isHovered, isCompact, isClosingTab);
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

  const tabChipStyle = useCallback(
    () => [
      styles.tab,
      variant === "browser" && styles.browserTab,
      !isActive && isHovered && styles.tabHovered,
      isWeb && isDragging && ({ cursor: "grabbing" } as object),
      {
        minWidth: resolvedTabWidth,
        width: resolvedTabWidth,
        maxWidth: resolvedTabWidth,
      },
    ],
    [variant, isActive, isDragging, isHovered, resolvedTabWidth],
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
  const testIdentity =
    tab.target.kind === "new_tab" ? tab.tabId : buildDeterministicWorkspaceTabId(tab.target);
  const tabLabelSkeletonStyle = styles.tabLabelSkeleton;
  const tabLabelStyle = useMemo(
    () => [
      styles.tabLabel,
      isHighlighted && styles.tabLabelActive,
      presentation.requiresAttention && styles.tabLabelUnread,
    ],
    [isHighlighted, presentation.requiresAttention],
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
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              testID={`workspace-tab-${testIdentity}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as unknown as undefined}
              style={tabChipStyle}
              onPressIn={isWeb ? handleNavigateTab : undefined}
              onPress={handleNavigateTab}
              accessibilityRole="button"
              {...browserTabAccessibility(variant, isActive)}
              accessibilityLabel={accessibilityLabel}
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
                modifiedTestId={`workspace-tab-modified-${testIdentity}`}
                runningTestId={`workspace-tab-running-${testIdentity}`}
              />
              {isActive ? (
                <View
                  style={
                    isActiveFocused ? styles.tabActiveUnderline : styles.tabActiveUnfocusedUnderline
                  }
                  pointerEvents="none"
                />
              ) : null}
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            offset={8}
            maxWidth={720}
            testID={`workspace-tab-tooltip-${testIdentity}`}
          >
            {tab.target.kind === "agent" ? (
              <AgentTabTooltipBody
                serverId={serverId}
                agentId={tab.target.agentId}
                title={tooltipLabel}
              />
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
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.menu.close")}
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

function useBrowserTabRow({
  variant,
  tabs,
  viewportWidth,
  layoutSignature,
  onNavigateTab,
  label,
}: {
  variant: "workspace" | "browser";
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
  viewportWidth: number;
  layoutSignature: string;
  onNavigateTab: (tabId: string) => void;
  label: string;
}) {
  const rowRef = useRef<View>(null);
  const activeBrowserTabId =
    variant === "browser" ? tabs.find((item) => item.isActive)?.tab.tabId : null;
  useLayoutEffect(() => {
    if (!isWeb || !activeBrowserTabId) return;
    const row = rowRef.current as unknown as HTMLElement | null;
    const selected = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const scroller = row?.querySelector<HTMLElement>('[data-testid="workspace-tabs-scroll"]');
    if (!selected || !scroller) return;
    const tabBounds = selected.getBoundingClientRect();
    const scrollBounds = scroller.getBoundingClientRect();
    if (tabBounds.left < scrollBounds.left)
      scroller.scrollLeft += tabBounds.left - scrollBounds.left;
    else if (tabBounds.right > scrollBounds.right)
      scroller.scrollLeft += tabBounds.right - scrollBounds.right;
  }, [activeBrowserTabId, viewportWidth, layoutSignature]);

  const handleBrowserRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        !isWeb ||
        variant !== "browser" ||
        !(event.target instanceof HTMLElement) ||
        event.target.getAttribute("role") !== "tab"
      )
        return;
      const row = rowRef.current as unknown as HTMLElement | null;
      const elements = Array.from(row?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
      const index = elements.indexOf(event.target);
      let next: number;
      switch (event.key) {
        case "ArrowRight":
          next = (index + 1) % elements.length;
          break;
        case "ArrowLeft":
          next = (index - 1 + elements.length) % elements.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = elements.length - 1;
          break;
        default:
          return;
      }
      const tab = tabs[next];
      if (!tab) return;
      event.preventDefault();
      event.stopPropagation();
      onNavigateTab(tab.tab.tabId);
      elements[next]?.focus({ preventScroll: true });
    },
    [variant, tabs, onNavigateTab],
  );

  return {
    ref: rowRef,
    props:
      isWeb && variant === "browser"
        ? {
            onKeyDown: handleBrowserRowKeyDown,
            accessibilityRole: "tablist" as const,
            accessibilityLabel: label,
          }
        : {},
  };
}

function BrowserTabMenuItem({
  item,
  onNavigateTab,
}: {
  item: ResolvedWorkspaceDesktopTabRowItem;
  onNavigateTab: (tabId: string) => void;
}) {
  const onSelect = useCallback(
    () => onNavigateTab(item.tab.tabId),
    [item.tab.tabId, onNavigateTab],
  );
  return (
    <DropdownMenuItem onSelect={onSelect} selected={item.isActive}>
      {item.presentation.label}
    </DropdownMenuItem>
  );
}

function browserTabAccessibility(variant: "workspace" | "browser", isActive: boolean) {
  // React Native Web prefers the sortable handle's raw role over accessibilityRole.
  return variant === "browser"
    ? {
        role: "tab" as const,
        accessibilityRole: "tab" as const,
        tabIndex: isActive ? (0 as const) : (-1 as const),
      }
    : {};
}

function ResolvedWorkspaceDesktopTabsRow({
  variant = "workspace",
  host = "main",
  launchPurpose = "primary",
  paneId,
  isFocused = false,
  ownsKeyboardShortcuts = isFocused,
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
  onCreateNewTab,
  onReorderTabs,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showPaneSplitActions = false,
  showPaneMaximizeAction = false,
  paneMaximized = false,
  onTogglePaneMaximized,
  onSplitRight,
  onSplitDown,
  focusModeEnabled,
  onExitFocusMode,
}: ResolvedWorkspaceDesktopTabsRowProps) {
  const { t } = useTranslation();
  const browserWorkspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const canReopenBrowser = useBrowserStore((state) =>
    Boolean(
      getIsElectron() && browserWorkspaceKey && state.lastClosedByWorkspace[browserWorkspaceKey],
    ),
  );
  const dispatcher = useKeyboardActionDispatcher();
  const handleReopenBrowser = useCallback(() => {
    dispatcher.dispatch({ id: "workspace.browser.reopen-last-closed", scope: "workspace" });
  }, [dispatcher]);
  const newTabKeys = useShortcutKeys("workspace-tab-new");
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const [rowHovered, setRowHovered] = useState(false);
  const [exitFocusModeWidth, setExitFocusModeWidth] = useState<number>(0);
  const tabScrollBoundary = useHorizontalScrollBoundary();
  const tabsScrollRef = useRef<NativeScrollView | null>(null);
  const [labelMeasurements, setLabelMeasurements] = useState(
    () => new Map<string, WorkspaceTabLabelMeasurement>(),
  );
  const [trackSnapshot, setTrackSnapshot] = useState<WorkspaceTabTrackSnapshot | null>(null);

  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsContainerWidth, event);
  }, []);

  const handleExitFocusModeLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setExitFocusModeWidth, event);
  }, []);

  const layoutMetrics = useMemo(
    () => ({
      rowHorizontalInset: 0,
      actionsReservedWidth: Math.max(
        0,
        DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH +
          smallIconButtonChromeFrameSize(false) +
          (variant === "browser" ? smallIconButtonChromeFrameSize(false) : 0) +
          (focusModeEnabled ? exitFocusModeWidth : 0) +
          (showPaneSplitActions ? PANE_SPLIT_ACTIONS_RESERVED_WIDTH : 0) +
          (showPaneMaximizeAction ? PANE_MAXIMIZE_ACTION_RESERVED_WIDTH : 0),
      ),
      rowPaddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
      tabGap: TAB_CHIP_GAP,
      fitContent: host === "explorer" && variant !== "browser",
      minTabWidth: variant === "browser" ? 120 : TAB_MIN_WIDTH,
      maxTabWidth: variant === "browser" ? 220 : TAB_MAX_WIDTH,
      // Iconified tabs carry their icon inside their measured label width, so the shared chrome
      // stays icon-free and agent tabs are not billed for a slot they never render.
      tabIconWidth: variant === "browser" ? TAB_ICON_WIDTH : 0,
      tabContentGap: variant === "browser" ? TAB_CONTENT_GAP : 0,
      tabHorizontalPadding: TAB_CHIP_HORIZONTAL_PADDING,
      closeButtonWidth: variant === "browser" ? 24 : TAB_CLOSE_BUTTON_RESERVED_WIDTH,
    }),
    [
      variant,
      exitFocusModeWidth,
      focusModeEnabled,
      host,
      showPaneMaximizeAction,
      showPaneSplitActions,
    ],
  );

  const panePanelKinds = useMemo(() => tabs.map(({ tab }) => tab.kind), [tabs]);

  const fallbackTabLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
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
        return {
          key: tab.tab.key,
          label,
          modified: tab.presentation.modified,
          requiresAttention: Boolean(tab.presentation.requiresAttention),
          icon: tab.tab.target.kind !== "agent" && tab.tab.target.kind !== "provider_subagent",
        };
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
    (key: string, label: string, requiresAttention: boolean, event: LayoutChangeEvent) => {
      const width = Math.ceil(event.nativeEvent.layout.width);
      if (width <= 0) {
        return;
      }
      setLabelMeasurements((current) => {
        const measurement = current.get(key);
        if (
          measurement?.label === label &&
          measurement.requiresAttention === requiresAttention &&
          measurement.width === width
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(key, { label, requiresAttention, width });
        return next;
      });
    },
    [],
  );

  const displayedTabs = useMemo(() => {
    if (variant === "browser") return tabs;
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
  }, [variant, tabLabels, tabs, trackSnapshot]);

  const { layout } = useWorkspaceTabLayout({
    variant,
    tabLabelWidths: variant === "browser" ? tabs.map(() => 0) : (trackSnapshot?.labelWidths ?? []),
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

  const createNewTab = useCallback(
    () => onCreateNewTab({ paneId, kind: variant === "browser" ? "browser" : undefined }),
    [variant, onCreateNewTab, paneId],
  );

  const handleNewTabKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!ownsKeyboardShortcuts) return false;
      if (action.id === "workspace.tab.menu.open") {
        createNewTab();
        return true;
      }
      return false;
    },
    [createNewTab, ownsKeyboardShortcuts],
  );

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      paneId,
    }),
    actions: ["workspace.tab.menu.open"],
    enabled: ownsKeyboardShortcuts,
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
      const shouldShowCloseButton =
        layout.closeButtonPolicy === "all" && item.presentation.showCloseButton;
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
          variant={variant}
          key={`${item.tab.key}:${item.tab.kind}`}
          serverId={normalizedServerId}
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
      variant,
      activeDragTabId,
      isFocused,
      layout.closeButtonPolicy,
      layout.items,
      normalizedServerId,
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

  useEffect(() => {
    if (!isWeb || !layout.requiresHorizontalScrollFallback) return;

    const scrollNode = tabsScrollRef.current?.getScrollableNode();
    if (!(scrollNode instanceof HTMLElement)) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      let horizontalDelta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        horizontalDelta *= 16;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        horizontalDelta *= scrollNode.clientWidth;
      }

      const maxScrollLeft = scrollNode.scrollWidth - scrollNode.clientWidth;
      const nextScrollLeft = Math.max(
        0,
        Math.min(maxScrollLeft, scrollNode.scrollLeft + horizontalDelta),
      );
      if (nextScrollLeft === scrollNode.scrollLeft) return;

      event.preventDefault();
      scrollNode.scrollLeft = nextScrollLeft;
    };

    scrollNode.addEventListener("wheel", handleWheel, { passive: false });
    return () => scrollNode.removeEventListener("wheel", handleWheel);
  }, [layout.requiresHorizontalScrollFallback]);

  const browserRow = useBrowserTabRow({
    variant,
    tabs: displayedTabs,
    viewportWidth: tabsContainerWidth,
    layoutSignature: JSON.stringify([
      displayedTabs.map(({ tab }) => tab.tabId),
      layout.items,
      layoutMetrics.actionsReservedWidth,
    ]),
    onNavigateTab,
    label: t("workspace.browser.tabs"),
  });

  const row = (
    <View
      ref={browserRow.ref}
      {...browserRow.props}
      style={styles.tabsContainer}
      testID="workspace-tabs-row"
      {...(isWeb
        ? { onMouseEnter: () => setRowHovered(true), onMouseLeave: () => setRowHovered(false) }
        : {})}
      onLayout={handleTabsContainerLayout}
    >
      <View
        style={styles.tabLabelMeasurements}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {tabLabels.map(({ key, label, requiresAttention }) => (
          <TabLabelMeasurement
            key={`${key}:${label}:${requiresAttention}`}
            tabKey={key}
            label={label}
            requiresAttention={requiresAttention}
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
          ref={tabsScrollRef}
          horizontal
          scrollEnabled={layout.requiresHorizontalScrollFallback}
          testID="workspace-tabs-scroll"
          style={tabsScrollStyle}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
          onLayout={tabScrollBoundary.onLayout}
          onContentSizeChange={tabScrollBoundary.onContentSizeChange}
          onScroll={tabScrollBoundary.onScroll}
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
              variant={variant}
              panePanelKinds={panePanelKinds}
              host={host}
              launchPurpose={launchPurpose}
              placement="inline"
              serverId={normalizedServerId}
              paneId={paneId}
              shortcutKeys={newTabKeys}
              onCreateNewTab={createNewTab}
            />
          ) : null}
        </Animated.ScrollView>
        <HorizontalScrollBoundaryShades
          visible={layout.requiresHorizontalScrollFallback}
          backdrop="surface"
          testIDPrefix="workspace-tabs-scroll-shade"
          leftStyle={tabScrollBoundary.leftShadeStyle}
          rightStyle={tabScrollBoundary.rightShadeStyle}
        />
      </View>
      <WorkspaceHistoryMenu
        serverId={normalizedServerId}
        workspaceId={normalizedWorkspaceId}
        revealed={rowHovered}
      />
      {variant === "browser" ? (
        <DropdownMenu>
          <ToolbarButton kind="menu" label={t("workspace.browser.allTabs")}>
            <ThemedChevronDown size={14} uniProps={extraMutedColorMapping} />
          </ToolbarButton>
          <DropdownMenuContent side="bottom" align="end" width={DROPDOWN_WIDTH}>
            {displayedTabs.map((item) => (
              <BrowserTabMenuItem key={item.tab.tabId} item={item} onNavigateTab={onNavigateTab} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              testID="workspace-browser-reopen-last-closed"
              disabled={!canReopenBrowser}
              onSelect={handleReopenBrowser}
            >
              {t("workspace.browser.reopenLastClosedTab")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <WorkspacePaneToolbarActions
        variant={variant}
        panePanelKinds={panePanelKinds}
        host={host}
        launchPurpose={launchPurpose}
        showNewTabButton={layout.requiresHorizontalScrollFallback}
        showSplitActions={showPaneSplitActions}
        showMaximizeAction={showPaneMaximizeAction}
        paneMaximized={paneMaximized}
        newTabShortcutKeys={newTabKeys}
        serverId={normalizedServerId}
        paneId={paneId}
        onCreateNewTab={createNewTab}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onTogglePaneMaximized={onTogglePaneMaximized}
      />
    </View>
  );

  return <RenderProfile id="WorkspaceDesktopTabsRow">{row}</RenderProfile>;
}
function ResolvedDesktopTabChip({
  variant,
  serverId,
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
  variant: "workspace" | "browser";
  serverId: string;
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

  const rawTooltipLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.tooltip;
  // The tooltip carries the full title: agent titles are whitespace-normalized but never
  // truncated, matching the single ellipsized line in the tab.
  const accessibilityLabel =
    item.tab.target.kind === "agent"
      ? normalizeAgentTooltipTitle(rawTooltipLabel)
      : rawTooltipLabel;
  const tooltipLabel = accessibilityLabel;

  return (
    <View style={styles.tabSlot}>
      {showDropIndicatorBefore ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
      ) : null}
      <TabChip
        variant={variant}
        serverId={serverId}
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
        accessibilityLabel={accessibilityLabel}
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
    borderBottomColor: theme.colors.workspace.border,
    backgroundColor: theme.colors.workspace.chrome,
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
  exitFocusModeSlot: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[0.5],
    borderRightWidth: 1,
    borderRightColor: theme.colors.workspace.border,
  },
  inlineAddButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  inlineNewTabButton: {
    width: buttonControlHeight.xs,
    height: buttonControlHeight.xs,
  },
  paneSplitActions: {
    paddingHorizontal: PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING,
    marginRight: PANE_SPLIT_ACTIONS_OUTER_MARGIN,
  },
  tab: {
    height: TAB_ROW_INNER_HEIGHT,
    paddingHorizontal: TAB_CHIP_HORIZONTAL_PADDING,
    borderRadius: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  browserTab: {
    paddingRight: TAB_CHIP_HORIZONTAL_PADDING + 24,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface1,
  },
  tabActiveUnderline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: TAB_ACTIVE_UNDERLINE_HEIGHT,
    backgroundColor: theme.colors.workspace.tabAccent,
    pointerEvents: "none",
  },
  tabActiveUnfocusedUnderline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: TAB_ACTIVE_UNDERLINE_HEIGHT,
    backgroundColor: theme.colors.foregroundExtraMuted,
    pointerEvents: "none",
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
    backgroundColor: theme.colors.workspace.tabAccent,
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
  tabLabelUnread: {
    fontWeight: theme.fontWeight.bold,
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
  tabModifiedDot: {
    width: TAB_MODIFIED_DOT_SIZE,
    height: TAB_MODIFIED_DOT_SIZE,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipAgentContent: {
    gap: theme.spacing[0.5],
    maxWidth: 420,
  },
  agentTooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipAgentMetadata: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipAgentSeparator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipAgentActivity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
