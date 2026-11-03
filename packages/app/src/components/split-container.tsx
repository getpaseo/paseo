import { useWorkspaceTabDrag } from "./workspace-tab-drag-context";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { RetainedPanel } from "@/components/retained-panel";
import {
  hasMultipleVisiblePanes,
  resolveSplitContainerRoot,
  splitNodeContainsPane,
} from "@/components/split-container-focus";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import {
  WindowChromeRegion,
  WindowChromeSafeArea,
  useWindowChromeCorners,
  removeWindowChromeCorner,
  type WindowChromeCorners,
} from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { type TabDropPreview } from "@/components/split-container-tab-drop-preview";
import { SplitDropZone, type SplitDropZoneHover } from "@/components/split-drop-zone";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  collectAllPanes,
  createDefaultLayout,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { recordRenderProfileReasons, RenderProfile } from "@/utils/render-profiler";
import { isNative } from "@/constants/platform";

interface SplitContainerProps {
  layout: WorkspaceLayout;
  renderMainHeader?: () => ReactNode;
  workspaceKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  uiTabs: WorkspaceTab[];
  hoveredCloseTabKey: string | null;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  closingTabIds: Set<string>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCreateNewTab: (input: { paneId?: string }) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  onFocusPane: (paneId: string) => void;
  onSplitPane: (input: {
    tabId: string;
    targetPaneId: string;
    position: "left" | "right" | "top" | "bottom";
  }) => void;
  onSplitPaneEmpty: (input: {
    targetPaneId: string;
    position: "left" | "right" | "top" | "bottom";
  }) => void;
  onMoveTabToPane: (tabId: string, toPaneId: string) => void;
  onSelectTabInPane: (paneId: string, tabId: string) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  focusModeEnabled?: boolean;
  onExitFocusMode: () => void;
}

interface SplitNodeViewProps extends Omit<
  SplitContainerProps,
  "layout" | "onMoveTabToPane" | "onSelectTabInPane"
> {
  node: SplitNode;
  uiTabs: WorkspaceTab[];
  focusedPaneId: string | null;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
  windowChromeCorners: WindowChromeCorners;
  maximizedPaneId: string | null;
  workspaceHasMultiplePanes: boolean;
  onTogglePaneMaximized: (paneId: string) => void;
}

interface SplitPaneViewProps extends Omit<
  SplitNodeViewProps,
  | "node"
  | "workspaceKey"
  | "focusedPaneId"
  | "activeDragTabId"
  | "showDropZones"
  | "dropPreview"
  | "onResizeSplit"
  | "windowChromeCorners"
> {
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  isFocused: boolean;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
}

const EMPTY_SPLIT_NODES: SplitNode[] = [];
const EMPTY_SPLIT_SIZES: number[] = [];

export function SplitContainer({
  layout,
  renderMainHeader,
  workspaceKey,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  uiTabs,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
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
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onResizeSplit,
  onReorderTabsInPane,
  focusModeEnabled,
  onExitFocusMode,
}: SplitContainerProps) {
  const inheritedWindowChromeCorners = useWindowChromeCorners();
  const windowChromeCorners = focusModeEnabled ? inheritedWindowChromeCorners : "none";
  const { activeDragTabId, dropPreview, tabDropPreview } = useWorkspaceTabDrag();
  const [maximizedPane, setMaximizedPane] = useState<{
    workspaceKey: string;
    paneId: string;
  } | null>(null);
  const maximizedPaneId =
    maximizedPane?.workspaceKey === workspaceKey ? maximizedPane.paneId : null;
  const explorerSidebarPaneId = useWorkspaceLayoutStore((state) =>
    selectExplorerSidebarPaneId(state, workspaceKey),
  );

  const mainRoot = useMemo(
    () => removePaneFromSplitTree(layout.root, explorerSidebarPaneId),
    [layout.root, explorerSidebarPaneId],
  );
  const workspaceHasMultiplePanes = Boolean(mainRoot && hasMultipleVisiblePanes(mainRoot));
  useEffect(() => {
    if (
      maximizedPaneId &&
      (focusModeEnabled ||
        !workspaceHasMultiplePanes ||
        !mainRoot ||
        !splitNodeContainsPane(mainRoot, maximizedPaneId))
    ) {
      setMaximizedPane(null);
    }
  }, [focusModeEnabled, mainRoot, maximizedPaneId, workspaceHasMultiplePanes]);
  const handleTogglePaneMaximized = useCallback(
    (paneId: string) => {
      setMaximizedPane((current) =>
        current?.workspaceKey === workspaceKey && current.paneId === paneId
          ? null
          : { workspaceKey, paneId },
      );
    },
    [workspaceKey],
  );
  const splitRoot = useMemo(
    () =>
      resolveSplitContainerRoot({
        root: mainRoot ?? createDefaultLayout().root,
        focusedPaneId: layout.focusedPaneId,
        focusModeEnabled,
      }),
    [focusModeEnabled, layout.focusedPaneId, mainRoot],
  );
  const explorerPane = explorerSidebarPaneId
    ? collectAllPanes(layout.root).find((pane) => pane.id === explorerSidebarPaneId)
    : null;
  const mainColumnWindowChromeCorners =
    !focusModeEnabled && explorerPane && !explorerPane.hidden
      ? removeWindowChromeCorner(inheritedWindowChromeCorners, "top-right")
      : inheritedWindowChromeCorners;
  const mainColumnStyle = styles.mainColumn;
  const renderRoot = useMemo(() => wrapRootPaneForStableMount(splitRoot.root), [splitRoot.root]);
  return (
    <RenderProfile id="SplitContainer">
      <View style={styles.workspaceShell}>
        <WindowChromeRegion corners={mainColumnWindowChromeCorners}>
          <View style={mainColumnStyle}>
            {renderMainHeader?.()}
            {splitRoot.usesFallbackStrip && <WindowChromeSafeArea placement="below" />}
            {renderRoot ? (
              <SplitNodeView
                node={renderRoot}
                workspaceKey={workspaceKey}
                uiTabs={uiTabs}
                focusedPaneId={layout.focusedPaneId}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                isWorkspaceFocused={isWorkspaceFocused}
                hoveredCloseTabKey={hoveredCloseTabKey}
                setHoveredCloseTabKey={setHoveredCloseTabKey}
                closingTabIds={closingTabIds}
                onNavigateTab={onNavigateTab}
                onCloseTab={onCloseTab}
                onCopyResumeCommand={onCopyResumeCommand}
                onCopyAgentId={onCopyAgentId}
                onCopyTerminalId={onCopyTerminalId}
                onCopyFilePath={onCopyFilePath}
                onReloadAgent={onReloadAgent}
                onRenameTab={onRenameTab}
                onCloseTabsToLeft={onCloseTabsToLeft}
                onCloseTabsToRight={onCloseTabsToRight}
                onCloseOtherTabs={onCloseOtherTabs}
                onCreateNewTab={onCreateNewTab}
                buildPaneContentModel={buildPaneContentModel}
                onFocusPane={onFocusPane}
                onSplitPane={onSplitPane}
                onSplitPaneEmpty={onSplitPaneEmpty}
                onResizeSplit={onResizeSplit}
                onReorderTabsInPane={onReorderTabsInPane}
                activeDragTabId={activeDragTabId}
                showDropZones={activeDragTabId !== null}
                dropPreview={dropPreview}
                tabDropPreview={tabDropPreview}
                windowChromeCorners={splitRoot.usesFallbackStrip ? "none" : windowChromeCorners}
                maximizedPaneId={maximizedPaneId}
                workspaceHasMultiplePanes={workspaceHasMultiplePanes}
                onTogglePaneMaximized={handleTogglePaneMaximized}
                focusModeEnabled={focusModeEnabled}
                onExitFocusMode={onExitFocusMode}
              />
            ) : null}
          </View>
        </WindowChromeRegion>
      </View>
    </RenderProfile>
  );
}

function SplitGroupChild({
  resizeFlex,
  index,
  hidden,
  children,
}: {
  resizeFlex: SharedValue<number[]>;
  index: number;
  hidden: boolean;
  children: ReactNode;
}) {
  const resizeStyle = useAnimatedStyle(() => ({
    flexGrow: resizeFlex.value[index] ?? 0,
  }));
  const childStyle = useMemo(
    () => [
      styles.groupChild,
      {
        flexShrink: hidden ? 0 : 1,
        flexBasis: 0,
        ...(hidden ? { width: 0, height: 0 } : {}),
      },
    ],
    [hidden],
  );
  return (
    <Animated.View
      style={[childStyle, resizeStyle]}
      testID={hidden ? "split-group-child-hidden" : "split-group-child"}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Flex grow per child, renormalized so the visible ones always sum to 1.
 *
 * `sizes` are fractions, so a two-pane group is `[0.5, 0.5]`. Hiding one child drops the group's
 * total grow factor to 0.5, and CSS hands children that sum to less than 1 only that fraction of
 * the free space — the other half of the row is simply left empty. Renormalizing is what makes a
 * hidden pane give its space back instead of just going invisible. The stored `sizes` are never
 * touched, so unhiding restores the width the user dragged to.
 */
function resolveVisibleGroupFlex(
  children: SplitNode[],
  sizes: number[],
  maximizedPaneId: string | null,
): number[] {
  const visibleTotal = children.reduce(
    (total, child, index) =>
      isSplitNodeHiddenForPresentation(child, maximizedPaneId)
        ? total
        : total + (sizes[index] ?? 1),
    0,
  );
  if (visibleTotal <= 0) {
    return children.map(() => 0);
  }
  return children.map((child, index) =>
    isSplitNodeHiddenForPresentation(child, maximizedPaneId)
      ? 0
      : (sizes[index] ?? 1) / visibleTotal,
  );
}

function isSplitNodeHiddenForPresentation(
  node: SplitNode,
  maximizedPaneId: string | null,
): boolean {
  return (
    isSplitNodeHidden(node) ||
    Boolean(maximizedPaneId && !splitNodeContainsPane(node, maximizedPaneId))
  );
}

function isSplitNodeHidden(node: SplitNode): boolean {
  if (node.kind === "pane") {
    return node.pane.hidden === true;
  }
  return node.group.children.every(isSplitNodeHidden);
}

function SplitNodeView({
  node,
  workspaceKey,
  uiTabs,
  focusedPaneId,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
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
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onResizeSplit,
  onReorderTabsInPane,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  windowChromeCorners,
  maximizedPaneId,
  workspaceHasMultiplePanes,
  onTogglePaneMaximized,
  focusModeEnabled,
  onExitFocusMode,
}: SplitNodeViewProps) {
  const [groupContainerSize, setGroupContainerSize] = useState(0);
  const groupId = node.kind === "group" ? node.group.id : null;
  const groupDirection = node.kind === "group" ? node.group.direction : null;

  const storedGroupSizes = useWorkspaceLayoutStore((state) =>
    groupId ? state.splitSizesByWorkspace[workspaceKey]?.[groupId] : undefined,
  );
  const groupChildren = node.kind === "group" ? node.group.children : EMPTY_SPLIT_NODES;
  const groupSizes =
    storedGroupSizes ?? (node.kind === "group" ? node.group.sizes : EMPTY_SPLIT_SIZES);
  const visibleFlex = useMemo(
    () => resolveVisibleGroupFlex(groupChildren, groupSizes, maximizedPaneId),
    [groupChildren, groupSizes, maximizedPaneId],
  );
  const resizeFlex = useSharedValue(visibleFlex);
  useEffect(() => {
    resizeFlex.value = visibleFlex;
  }, [resizeFlex, visibleFlex]);
  const previewResizeSplit = useCallback(
    (_groupId: string, sizes: number[]) => {
      resizeFlex.value = resolveVisibleGroupFlex(groupChildren, sizes, maximizedPaneId);
    },
    [groupChildren, maximizedPaneId, resizeFlex],
  );
  const handleGroupLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextSize =
        groupDirection === "horizontal"
          ? event.nativeEvent.layout.width
          : event.nativeEvent.layout.height;
      setGroupContainerSize((current) => (current === nextSize ? current : nextSize));
    },
    [groupDirection],
  );

  const groupStyle = useMemo(
    () => [
      styles.group,
      groupDirection === "horizontal" ? styles.groupHorizontal : styles.groupVertical,
    ],
    [groupDirection],
  );

  if (node.kind === "pane") {
    return (
      <RetainedPanel
        active={node.pane.hidden !== true && (!maximizedPaneId || node.pane.id === maximizedPaneId)}
      >
        <WindowChromeRegion corners={windowChromeCorners}>
          <SplitPaneView
            pane={node.pane}
            uiTabs={uiTabs}
            isFocused={node.pane.id === focusedPaneId}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            isWorkspaceFocused={isWorkspaceFocused}
            hoveredCloseTabKey={hoveredCloseTabKey}
            setHoveredCloseTabKey={setHoveredCloseTabKey}
            closingTabIds={closingTabIds}
            onNavigateTab={onNavigateTab}
            onCloseTab={onCloseTab}
            onCopyResumeCommand={onCopyResumeCommand}
            onCopyAgentId={onCopyAgentId}
            onCopyTerminalId={onCopyTerminalId}
            onCopyFilePath={onCopyFilePath}
            onReloadAgent={onReloadAgent}
            onRenameTab={onRenameTab}
            onCloseTabsToLeft={onCloseTabsToLeft}
            onCloseTabsToRight={onCloseTabsToRight}
            onCloseOtherTabs={onCloseOtherTabs}
            onCreateNewTab={onCreateNewTab}
            buildPaneContentModel={buildPaneContentModel}
            onFocusPane={onFocusPane}
            onSplitPane={onSplitPane}
            onSplitPaneEmpty={onSplitPaneEmpty}
            onReorderTabsInPane={onReorderTabsInPane}
            activeDragTabId={activeDragTabId}
            showDropZones={showDropZones}
            dropPreview={dropPreview}
            tabDropPreview={tabDropPreview}
            maximizedPaneId={maximizedPaneId}
            workspaceHasMultiplePanes={workspaceHasMultiplePanes}
            onTogglePaneMaximized={onTogglePaneMaximized}
            focusModeEnabled={focusModeEnabled}
            onExitFocusMode={onExitFocusMode}
          />
        </WindowChromeRegion>
      </RetainedPanel>
    );
  }

  return (
    <View style={groupStyle} onLayout={handleGroupLayout}>
      {node.group.children.map((child, index) => (
        <Fragment key={getNodeKey(child)}>
          <SplitGroupChild
            resizeFlex={resizeFlex}
            index={index}
            hidden={isSplitNodeHiddenForPresentation(child, maximizedPaneId)}
          >
            <SplitNodeView
              node={child}
              workspaceKey={workspaceKey}
              uiTabs={uiTabs}
              focusedPaneId={focusedPaneId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              closingTabIds={closingTabIds}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onCopyTerminalId={onCopyTerminalId}
              onCopyFilePath={onCopyFilePath}
              onReloadAgent={onReloadAgent}
              onRenameTab={onRenameTab}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onCreateNewTab={onCreateNewTab}
              buildPaneContentModel={buildPaneContentModel}
              onFocusPane={onFocusPane}
              onSplitPane={onSplitPane}
              onSplitPaneEmpty={onSplitPaneEmpty}
              onResizeSplit={onResizeSplit}
              onReorderTabsInPane={onReorderTabsInPane}
              activeDragTabId={activeDragTabId}
              showDropZones={showDropZones}
              dropPreview={dropPreview}
              tabDropPreview={tabDropPreview}
              windowChromeCorners={windowChromeCorners}
              maximizedPaneId={maximizedPaneId}
              workspaceHasMultiplePanes={workspaceHasMultiplePanes}
              onTogglePaneMaximized={onTogglePaneMaximized}
              focusModeEnabled={focusModeEnabled}
              onExitFocusMode={onExitFocusMode}
            />
          </SplitGroupChild>
          {index < node.group.children.length - 1 &&
          !isSplitNodeHiddenForPresentation(child, maximizedPaneId) &&
          !isSplitNodeHiddenForPresentation(node.group.children[index + 1], maximizedPaneId) ? (
            <ResizeHandle
              testID="workspace-split-resize-handle"
              direction={node.group.direction}
              groupId={node.group.id}
              index={index}
              sizes={groupSizes}
              containerSize={groupContainerSize}
              onPreviewResizeSplit={previewResizeSplit}
              onResizeSplit={onResizeSplit}
            />
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

const SplitPaneView = memo(function SplitPaneView({
  pane,
  uiTabs,
  isFocused,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
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
  buildPaneContentModel,
  onFocusPane,
  onSplitPane: _onSplitPane,
  onSplitPaneEmpty,
  onReorderTabsInPane,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  maximizedPaneId,
  workspaceHasMultiplePanes,
  onTogglePaneMaximized,
  focusModeEnabled,
  onExitFocusMode,
}: SplitPaneViewProps) {
  recordRenderProfileReasons(`SplitPaneView:${pane.id}`, ["render"]);
  const paneRef = useRef<View | null>(null);
  const stableOnFocusPane = useStableEvent(onFocusPane);
  const paneState = useMemo(
    () =>
      deriveWorkspacePaneState({
        pane,
        tabs: uiTabs,
      }),
    [pane, uiTabs],
  );
  const paneTabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabDescriptor = paneState.activeTab?.descriptor ?? null;
  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      paneTabs.map((tab) => ({
        tab,
        isActive: tab.key === activeTabDescriptor?.key,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabDescriptor?.key, closingTabIds, hoveredCloseTabKey, paneTabs],
  );

  useEffect(() => {
    if (isNative) {
      return () => {};
    }

    const rawRef: unknown = paneRef.current;
    if (!(rawRef instanceof HTMLElement)) {
      return () => {};
    }
    const paneElement = rawRef;

    const handlePanePointerDown = (event: PointerEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    const handlePaneFocusIn = (event: FocusEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    paneElement.addEventListener("pointerdown", handlePanePointerDown, true);
    paneElement.addEventListener("focusin", handlePaneFocusIn, true);

    return () => {
      paneElement.removeEventListener("pointerdown", handlePanePointerDown, true);
      paneElement.removeEventListener("focusin", handlePaneFocusIn, true);
    };
  }, [stableOnFocusPane, pane.id]);

  const paneId = pane.id;
  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => onCloseTabsToLeft(tabId, paneTabs),
    [onCloseTabsToLeft, paneTabs],
  );
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => onCloseTabsToRight(tabId, paneTabs),
    [onCloseTabsToRight, paneTabs],
  );
  const handleCloseOtherTabs = useCallback(
    (tabId: string) => onCloseOtherTabs(tabId, paneTabs),
    [onCloseOtherTabs, paneTabs],
  );
  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      onReorderTabsInPane(
        paneId,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [onReorderTabsInPane, paneId],
  );
  const handleSplitRight = useCallback(
    () => onSplitPaneEmpty({ targetPaneId: paneId, position: "right" }),
    [onSplitPaneEmpty, paneId],
  );
  const handleSplitDown = useCallback(
    () => onSplitPaneEmpty({ targetPaneId: paneId, position: "bottom" }),
    [onSplitPaneEmpty, paneId],
  );
  const handleTogglePaneMaximized = useCallback(
    () => onTogglePaneMaximized(paneId),
    [onTogglePaneMaximized, paneId],
  );
  return (
    <RenderProfile id={`SplitPaneView:${pane.id}`}>
      <View
        ref={paneRef}
        collapsable={false}
        style={styles.pane}
        testID={`workspace-pane-${pane.id}`}
      >
        <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
          <TitlebarDragRegion />
          <WorkspaceDesktopTabsRow
            paneId={pane.id}
            isFocused={isFocused && isWorkspaceFocused}
            tabs={desktopTabRowItems}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            setHoveredCloseTabKey={setHoveredCloseTabKey}
            onNavigateTab={onNavigateTab}
            onCloseTab={onCloseTab}
            onCopyResumeCommand={onCopyResumeCommand}
            onCopyAgentId={onCopyAgentId}
            onCopyTerminalId={onCopyTerminalId}
            onCopyFilePath={onCopyFilePath}
            onReloadAgent={onReloadAgent}
            onRenameTab={onRenameTab}
            onCloseTabsToLeft={handleCloseTabsToLeft}
            onCloseTabsToRight={handleCloseTabsToRight}
            onCloseOtherTabs={handleCloseOtherTabs}
            onCreateNewTab={onCreateNewTab}
            onReorderTabs={handleReorderTabs}
            externalDndContext
            activeDragTabId={activeDragTabId}
            tabDropPreviewIndex={
              tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
            }
            showPaneSplitActions={!focusModeEnabled}
            showPaneMaximizeAction={workspaceHasMultiplePanes && !focusModeEnabled}
            paneMaximized={paneId === maximizedPaneId}
            onTogglePaneMaximized={handleTogglePaneMaximized}
            onSplitRight={handleSplitRight}
            onSplitDown={handleSplitDown}
            focusModeEnabled={Boolean(focusModeEnabled)}
            onExitFocusMode={onExitFocusMode}
          />
        </WindowChromeSafeArea>

        <View style={styles.paneContent}>
          <WorkspacePanelHost
            paneId={pane.id}
            tabs={paneTabs}
            activeTabId={activeTabDescriptor?.tabId ?? null}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={isFocused}
            onFocusPane={stableOnFocusPane}
            buildPaneContentModel={buildPaneContentModel}
          />
          <SplitDropZone paneId={pane.id} active={showDropZones} preview={dropPreview} />
        </View>
      </View>
    </RenderProfile>
  );
});

function getNodeKey(node: SplitNode): string {
  if (node.kind === "pane") {
    return node.pane.id;
  }
  return node.group.id;
}

function wrapRootPaneForStableMount(node: SplitNode): SplitNode {
  if (node.kind === "group") {
    return node;
  }

  return {
    kind: "group",
    group: {
      id: `root:${node.pane.id}`,
      direction: "horizontal",
      children: [node],
      sizes: [1],
    },
  };
}

function removePaneFromSplitTree(node: SplitNode, paneId: string | null): SplitNode | null {
  if (!paneId) {
    return node;
  }
  if (node.kind === "pane") {
    return node.pane.id === paneId ? null : node;
  }

  const children = node.group.children.flatMap((child) => {
    const nextChild = removePaneFromSplitTree(child, paneId);
    return nextChild ? [nextChild] : [];
  });
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0] ?? null;
  }
  return {
    kind: "group",
    group: {
      ...node.group,
      children,
      sizes: children.map(() => 1 / children.length),
    },
  };
}

const styles = StyleSheet.create((theme) => ({
  workspaceShell: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "row",
  },
  mainColumn: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 0,
  },
  group: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  groupHorizontal: {
    flexDirection: "row",
  },
  groupVertical: {
    flexDirection: "column",
  },
  groupChild: {
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  },
  pane: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  paneTabs: {
    position: "relative",
    minWidth: 0,
  },
  paneContent: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
}));
