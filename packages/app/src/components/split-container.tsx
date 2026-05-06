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
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import {
  computeTabDropPreview,
  type TabDropPreview,
} from "@/components/split-container-tab-drop-preview";
import {
  SplitDropZone,
  resolveSplitDropPosition,
  type SplitDropZoneHover,
} from "@/components/split-drop-zone";
import {
  deriveWorkspacePaneState,
  getWorkspacePaneDescriptors,
} from "@/screens/workspace/workspace-pane-state";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";
import { workspaceTabTargetsEqual } from "@/utils/workspace-tab-identity";
import { isNative } from "@/constants/platform";

interface SplitContainerProps {
  layout: WorkspaceLayout;
  workspaceKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  uiTabs: WorkspaceTab[];
  hoveredCloseTabKey: string | null;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  closingTabIds: Set<string>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onCloseTabsToLeft: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCreateDraftTab: (input: { paneId?: string }) => void;
  onCreateTerminalTab: (input: { paneId?: string }) => void;
  onCreateBrowserTab: (input: { paneId?: string }) => void;
  showCreateBrowserTab?: boolean;
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
  onResizeSplit: (groupId: string, sizes: number[]) => void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  renderPaneEmptyState?: () => ReactNode;
  focusModeEnabled?: boolean;
}

interface WorkspaceTabDragData {
  kind: "workspace-tab";
  paneId: string;
  tabId: string;
}

interface SplitPaneDropData {
  kind: "split-pane-drop";
  paneId: string;
}

function isWorkspaceTabDragData(data: unknown): data is WorkspaceTabDragData {
  return typeof data === "object" && data !== null && Reflect.get(data, "kind") === "workspace-tab";
}

function isSplitPaneDropData(data: unknown): data is SplitPaneDropData {
  return (
    typeof data === "object" && data !== null && Reflect.get(data, "kind") === "split-pane-drop"
  );
}

function asWorkspaceTabDragData(data: unknown): WorkspaceTabDragData | undefined {
  return isWorkspaceTabDragData(data) ? data : undefined;
}

function asDragOverData(data: unknown): WorkspaceTabDragData | SplitPaneDropData | undefined {
  if (isWorkspaceTabDragData(data)) return data;
  if (isSplitPaneDropData(data)) return data;
  return undefined;
}

interface SplitNodeViewProps extends Omit<SplitContainerProps, "layout" | "onMoveTabToPane"> {
  node: SplitNode;
  uiTabs: WorkspaceTab[];
  focusedPaneId: string | null;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
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
> {
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  isFocused: boolean;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
}

interface MountedTabSlotProps {
  tabDescriptor: WorkspaceTabDescriptor;
  isVisible: boolean;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  paneId: string;
  onFocusPane: (paneId: string) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

const MountedTabSlot = memo(function MountedTabSlot({
  tabDescriptor,
  isVisible,
  isWorkspaceFocused,
  isPaneFocused,
  paneId,
  onFocusPane,
  buildPaneContentModel,
}: MountedTabSlotProps) {
  const content = useMemo(
    () =>
      buildPaneContentModel({
        paneId,
        tab: tabDescriptor,
      }),
    [buildPaneContentModel, paneId, tabDescriptor],
  );

  const wrapperStyle = useMemo(() => {
    const display: "flex" | "none" = isVisible ? "flex" : "none";
    return { display, flex: 1 };
  }, [isVisible]);
  const handleFocusPane = useCallback(() => {
    onFocusPane(paneId);
  }, [onFocusPane, paneId]);

  return (
    <View style={wrapperStyle}>
      <WorkspacePaneContent
        content={content}
        isWorkspaceFocused={isWorkspaceFocused}
        isPaneFocused={isPaneFocused}
        onFocusPane={handleFocusPane}
      />
    </View>
  );
});

function useStableTabDescriptorMap(tabDescriptors: WorkspaceTabDescriptor[]) {
  const cacheRef = useRef(new Map<string, WorkspaceTabDescriptor>());
  const tabDescriptorMap = useMemo(() => {
    const next = new Map<string, WorkspaceTabDescriptor>();
    for (const tabDescriptor of tabDescriptors) {
      const cachedDescriptor = cacheRef.current.get(tabDescriptor.tabId);
      if (
        cachedDescriptor &&
        cachedDescriptor.key === tabDescriptor.key &&
        cachedDescriptor.kind === tabDescriptor.kind &&
        workspaceTabTargetsEqual(cachedDescriptor.target, tabDescriptor.target)
      ) {
        next.set(tabDescriptor.tabId, cachedDescriptor);
        continue;
      }
      next.set(tabDescriptor.tabId, tabDescriptor);
    }
    return next;
  }, [tabDescriptors]);
  useEffect(() => {
    cacheRef.current = tabDescriptorMap;
  }, [tabDescriptorMap]);

  return tabDescriptorMap;
}

interface DragMoveRects {
  translatedRect: { left: number; top: number; width: number; height: number };
  overRect: { left: number; top: number; width: number; height: number };
}

function resolveDragMoveRects(
  event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">,
): DragMoveRects | null {
  const translatedRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!translatedRect || !overRect || overRect.width <= 0 || overRect.height <= 0) {
    return null;
  }
  return { translatedRect, overRect };
}

function computeTabOverDropPreview(input: {
  activeData: WorkspaceTabDragData;
  overData: WorkspaceTabDragData;
  rects: DragMoveRects;
  panesById: Map<string, SplitPane>;
  uiTabs: WorkspaceTab[];
}): TabDropPreview | null {
  const { activeData, overData, rects, panesById, uiTabs } = input;
  const targetPane = panesById.get(overData.paneId) ?? null;
  if (!targetPane) {
    return null;
  }
  const targetTabs = getWorkspacePaneDescriptors({ pane: targetPane, tabs: uiTabs });
  return computeTabDropPreview({
    activePaneId: activeData.paneId,
    activeTabId: activeData.tabId,
    overPaneId: overData.paneId,
    overTabId: overData.tabId,
    targetTabs,
    activeRect: {
      left: rects.translatedRect.left,
      width: rects.translatedRect.width,
    },
    overRect: {
      left: rects.overRect.left,
      width: rects.overRect.width,
    },
  });
}

function computePaneOverDropPreview(input: {
  overData: SplitPaneDropData;
  rects: DragMoveRects;
}): SplitDropZoneHover | null {
  const { overData, rects } = input;
  const centerX = rects.translatedRect.left + rects.translatedRect.width / 2;
  const centerY = rects.translatedRect.top + rects.translatedRect.height / 2;
  const relativeX = centerX - rects.overRect.left;
  const relativeY = centerY - rects.overRect.top;
  if (
    Number.isNaN(relativeX) ||
    Number.isNaN(relativeY) ||
    relativeX < 0 ||
    relativeX > rects.overRect.width ||
    relativeY < 0 ||
    relativeY > rects.overRect.height
  ) {
    return null;
  }
  return {
    paneId: overData.paneId,
    position: resolveSplitDropPosition({
      width: rects.overRect.width,
      height: rects.overRect.height,
      x: relativeX,
      y: relativeY,
    }),
  };
}

const dropCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const tabHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "workspace-tab",
  );
  if (tabHits.length > 0) {
    return tabHits;
  }

  const paneHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "split-pane-drop",
  );
  if (paneHits.length > 0) {
    return paneHits;
  }

  return closestCenter(args);
};

export function SplitContainer({
  layout,
  workspaceKey,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  uiTabs,
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onReloadAgent,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onMoveTabToPane,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState = () => null,
  focusModeEnabled,
}: SplitContainerProps) {
  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<SplitDropZoneHover | null>(null);
  const [tabDropPreview, setTabDropPreview] = useState<TabDropPreview | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const panesById = useMemo(() => collectPanesById(layout.root), [layout.root]);

  const effectiveRoot = useMemo(() => {
    if (!focusModeEnabled) {
      return layout.root;
    }
    const focusedPane = layout.focusedPaneId ? panesById.get(layout.focusedPaneId) : null;
    if (!focusedPane) {
      return layout.root;
    }
    return { kind: "pane" as const, pane: focusedPane };
  }, [focusModeEnabled, layout.root, layout.focusedPaneId, panesById]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = asWorkspaceTabDragData(event.active.data.current);
    if (!data) {
      setActiveDragTabId(null);
      setDropPreview(null);
      setTabDropPreview(null);
      return;
    }
    setActiveDragTabId(data.tabId);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragTabId(null);
    setDropPreview(null);
    setTabDropPreview(null);
  }, []);

  const updateDropPreview = useCallback(
    (event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      if (activeData?.kind !== "workspace-tab") {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      const rects = resolveDragMoveRects(event);
      if (!rects) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "workspace-tab") {
        const preview = computeTabOverDropPreview({
          activeData,
          overData,
          rects,
          panesById,
          uiTabs,
        });
        setDropPreview(null);
        setTabDropPreview(preview);
        return;
      }

      setTabDropPreview(null);
      if (overData?.kind !== "split-pane-drop") {
        setDropPreview(null);
        return;
      }

      setDropPreview(computePaneOverDropPreview({ overData, rects }));
    },
    [panesById, uiTabs],
  );

  const applyTabDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: WorkspaceTabDragData }): void => {
      const { activeData, overData } = input;
      const sourcePane = panesById.get(activeData.paneId) ?? null;
      const targetPane = panesById.get(overData.paneId) ?? null;
      if (!sourcePane || !targetPane) {
        return;
      }

      const sourceTabs = getWorkspacePaneDescriptors({ pane: sourcePane, tabs: uiTabs });
      const targetTabs = getWorkspacePaneDescriptors({ pane: targetPane, tabs: uiTabs });
      const sourceIndex = sourceTabs.findIndex((tab) => tab.tabId === activeData.tabId);
      const resolvedTabDropPreview =
        tabDropPreview?.paneId === overData.paneId ? tabDropPreview : null;
      if (sourceIndex < 0 || !resolvedTabDropPreview) {
        return;
      }

      if (activeData.paneId === overData.paneId) {
        if (sourceIndex !== resolvedTabDropPreview.insertionIndex) {
          const nextTabs = arrayMove(
            sourceTabs,
            sourceIndex,
            resolvedTabDropPreview.insertionIndex,
          );
          onReorderTabsInPane(
            activeData.paneId,
            nextTabs.map((tab) => tab.tabId),
          );
        }
        return;
      }

      const nextTargetTabIds = targetTabs.map((tab) => tab.tabId);
      nextTargetTabIds.splice(resolvedTabDropPreview.insertionIndex, 0, activeData.tabId);
      onMoveTabToPane(activeData.tabId, overData.paneId);
      onReorderTabsInPane(overData.paneId, nextTargetTabIds);
    },
    [onMoveTabToPane, onReorderTabsInPane, panesById, tabDropPreview, uiTabs],
  );

  const applyPaneDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: SplitPaneDropData }): void => {
      const { activeData, overData } = input;
      if (dropPreview?.paneId !== overData.paneId) {
        return;
      }
      if (dropPreview.position === "center") {
        if (activeData.paneId !== overData.paneId) {
          onMoveTabToPane(activeData.tabId, overData.paneId);
        }
        return;
      }
      onSplitPane({
        tabId: activeData.tabId,
        targetPaneId: overData.paneId,
        position: dropPreview.position,
      });
    },
    [dropPreview, onMoveTabToPane, onSplitPane],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      setActiveDragTabId(null);

      if (activeData?.kind === "workspace-tab" && event.over) {
        if (overData?.kind === "workspace-tab") {
          applyTabDropEnd({ activeData, overData });
        } else if (overData?.kind === "split-pane-drop") {
          applyPaneDropEnd({ activeData, overData });
        }
      }

      setDropPreview(null);
      setTabDropPreview(null);
    },
    [applyTabDropEnd, applyPaneDropEnd],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={dropCollisionDetection}
      onDragStart={handleDragStart}
      onDragMove={updateDropPreview}
      onDragOver={updateDropPreview}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SplitNodeView
        node={effectiveRoot}
        workspaceKey={workspaceKey}
        uiTabs={uiTabs}
        focusedPaneId={layout.focusedPaneId}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        isWorkspaceFocused={isWorkspaceFocused}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredTabKey={setHoveredTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        closingTabIds={closingTabIds}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        onCopyResumeCommand={onCopyResumeCommand}
        onCopyAgentId={onCopyAgentId}
        onReloadAgent={onReloadAgent}
        onCloseTabsToLeft={onCloseTabsToLeft}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseOtherTabs={onCloseOtherTabs}
        onCreateDraftTab={onCreateDraftTab}
        onCreateTerminalTab={onCreateTerminalTab}
        onCreateBrowserTab={onCreateBrowserTab}
        showCreateBrowserTab={showCreateBrowserTab}
        buildPaneContentModel={buildPaneContentModel}
        onFocusPane={onFocusPane}
        onSplitPane={onSplitPane}
        onSplitPaneEmpty={onSplitPaneEmpty}
        onResizeSplit={onResizeSplit}
        onReorderTabsInPane={onReorderTabsInPane}
        renderPaneEmptyState={renderPaneEmptyState}
        activeDragTabId={activeDragTabId}
        showDropZones={activeDragTabId !== null}
        dropPreview={dropPreview}
        tabDropPreview={tabDropPreview}
      />
      <DragOverlay dropAnimation={null}>
        {activeDragTabId ? (
          <DragOverlayTabChip
            tabId={activeDragTabId}
            uiTabs={uiTabs}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DragOverlayTabChip({
  tabId,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tabId: string;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const tab = uiTabs.find((t) => t.tabId === tabId);
  const descriptor = useMemo<WorkspaceTabDescriptor | null>(
    () =>
      tab
        ? {
            key: tab.tabId,
            tabId: tab.tabId,
            kind: tab.target.kind,
            target: tab.target,
          }
        : null,
    [tab],
  );
  if (!descriptor) {
    return null;
  }
  return (
    <DragOverlayTabChipInner
      tab={descriptor}
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
    />
  );
}

function DragOverlayTabChipInner({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const { theme } = useUnistyles();

  const chipStyle = useMemo(
    () => [
      styles.dragOverlayChip,
      {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.borderAccent,
      },
    ],
    [theme.colors.surface1, theme.colors.borderAccent],
  );
  const chipLabelStyle = useMemo(
    () => [styles.dragOverlayLabel, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const label = presentation.titleState === "loading" ? "Loading..." : presentation.label;

        return (
          <View style={chipStyle}>
            <WorkspaceTabIcon presentation={presentation} active size={14} />
            <Text numberOfLines={1} style={chipLabelStyle}>
              {label}
            </Text>
          </View>
        );
      }}
    </WorkspaceTabPresentationResolver>
  );
}

function SplitGroupChild({ flex, children }: { flex: number; children: ReactNode }) {
  const childStyle = useMemo(() => [styles.groupChild, { flex }], [flex]);
  return <View style={childStyle}>{children}</View>;
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
  setHoveredTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onReloadAgent,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
}: SplitNodeViewProps) {
  const groupId = node.kind === "group" ? node.group.id : null;
  const groupDirection = node.kind === "group" ? node.group.direction : null;

  const storedGroupSizes = useWorkspaceLayoutStore((state) =>
    groupId ? state.splitSizesByWorkspace[workspaceKey]?.[groupId] : undefined,
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
      <SplitPaneView
        pane={node.pane}
        uiTabs={uiTabs}
        isFocused={node.pane.id === focusedPaneId}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        isWorkspaceFocused={isWorkspaceFocused}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredTabKey={setHoveredTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        closingTabIds={closingTabIds}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        onCopyResumeCommand={onCopyResumeCommand}
        onCopyAgentId={onCopyAgentId}
        onReloadAgent={onReloadAgent}
        onCloseTabsToLeft={onCloseTabsToLeft}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseOtherTabs={onCloseOtherTabs}
        onCreateDraftTab={onCreateDraftTab}
        onCreateTerminalTab={onCreateTerminalTab}
        onCreateBrowserTab={onCreateBrowserTab}
        showCreateBrowserTab={showCreateBrowserTab}
        buildPaneContentModel={buildPaneContentModel}
        onFocusPane={onFocusPane}
        onSplitPane={onSplitPane}
        onSplitPaneEmpty={onSplitPaneEmpty}
        onReorderTabsInPane={onReorderTabsInPane}
        renderPaneEmptyState={renderPaneEmptyState}
        activeDragTabId={activeDragTabId}
        showDropZones={showDropZones}
        dropPreview={dropPreview}
        tabDropPreview={tabDropPreview}
      />
    );
  }

  const groupSizes = storedGroupSizes ?? node.group.sizes;

  return (
    <View style={groupStyle}>
      {node.group.children.map((child, index) => (
        <Fragment key={getNodeKey(child)}>
          <SplitGroupChild flex={groupSizes[index] ?? 1}>
            <SplitNodeView
              node={child}
              workspaceKey={workspaceKey}
              uiTabs={uiTabs}
              focusedPaneId={focusedPaneId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredTabKey={setHoveredTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              closingTabIds={closingTabIds}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onReloadAgent={onReloadAgent}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onCreateDraftTab={onCreateDraftTab}
              onCreateTerminalTab={onCreateTerminalTab}
              onCreateBrowserTab={onCreateBrowserTab}
              showCreateBrowserTab={showCreateBrowserTab}
              buildPaneContentModel={buildPaneContentModel}
              onFocusPane={onFocusPane}
              onSplitPane={onSplitPane}
              onSplitPaneEmpty={onSplitPaneEmpty}
              onResizeSplit={onResizeSplit}
              onReorderTabsInPane={onReorderTabsInPane}
              renderPaneEmptyState={renderPaneEmptyState}
              activeDragTabId={activeDragTabId}
              showDropZones={showDropZones}
              dropPreview={dropPreview}
              tabDropPreview={tabDropPreview}
            />
          </SplitGroupChild>
          {index < node.group.children.length - 1 ? (
            <ResizeHandle
              direction={node.group.direction}
              groupId={node.group.id}
              index={index}
              sizes={groupSizes}
              onResizeSplit={onResizeSplit}
            />
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

function SplitPaneView({
  pane,
  uiTabs,
  isFocused,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onReloadAgent,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane: _onSplitPane,
  onSplitPaneEmpty,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
}: SplitPaneViewProps) {
  const { theme: _theme } = useUnistyles();
  const paneRef = useRef<View | null>(null);
  const stableOnFocusPane = useStableEvent(onFocusPane);
  const padding = useWindowControlsPadding("tabRow");
  const paneState = useMemo(
    () =>
      deriveWorkspacePaneState({
        pane,
        tabs: uiTabs,
      }),
    [pane, uiTabs],
  );
  const paneTabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const paneTabIds = useMemo(() => paneTabs.map((tab) => tab.tabId), [paneTabs]);
  const tabDescriptorMap = useStableTabDescriptorMap(paneTabs);
  const activeTabDescriptor = paneState.activeTab?.descriptor ?? null;
  const { mountedTabIds } = useMountedTabSet({
    activeTabId: activeTabDescriptor?.tabId ?? null,
    allTabIds: paneTabIds,
    cap: 3,
  });
  const mountedPaneTabIds = useMemo(
    () => paneTabIds.filter((tabId) => mountedTabIds.has(tabId)),
    [mountedTabIds, paneTabIds],
  );
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
  const paneTabsStyle = useMemo(
    () => [styles.paneTabs, { paddingLeft: padding.left, paddingRight: padding.right }],
    [padding.left, padding.right],
  );

  return (
    <View ref={paneRef} collapsable={false} style={styles.pane}>
      <View style={paneTabsStyle}>
        <TitlebarDragRegion />
        <WorkspaceDesktopTabsRow
          paneId={pane.id}
          isFocused={isFocused}
          tabs={desktopTabRowItems}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          setHoveredTabKey={setHoveredTabKey}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onReloadAgent={onReloadAgent}
          onCloseTabsToLeft={handleCloseTabsToLeft}
          onCloseTabsToRight={handleCloseTabsToRight}
          onCloseOtherTabs={handleCloseOtherTabs}
          onCreateDraftTab={onCreateDraftTab}
          onCreateTerminalTab={onCreateTerminalTab}
          onCreateBrowserTab={onCreateBrowserTab}
          showCreateBrowserTab={showCreateBrowserTab}
          onReorderTabs={handleReorderTabs}
          onSplitRight={handleSplitRight}
          onSplitDown={handleSplitDown}
          externalDndContext
          activeDragTabId={activeDragTabId}
          tabDropPreviewIndex={
            tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
          }
        />
      </View>

      <View style={styles.paneContent}>
        {mountedPaneTabIds.length > 0
          ? mountedPaneTabIds.map((tabId) => {
              const tabDescriptor = tabDescriptorMap.get(tabId);
              if (!tabDescriptor) {
                return null;
              }

              return (
                <MountedTabSlot
                  key={tabId}
                  tabDescriptor={tabDescriptor}
                  isVisible={tabId === activeTabDescriptor?.tabId}
                  isWorkspaceFocused={isWorkspaceFocused}
                  isPaneFocused={isFocused && tabId === activeTabDescriptor?.tabId}
                  paneId={pane.id}
                  onFocusPane={stableOnFocusPane}
                  buildPaneContentModel={buildPaneContentModel}
                />
              );
            })
          : (renderPaneEmptyState?.() ?? null)}
        <SplitDropZone paneId={pane.id} active={showDropZones} preview={dropPreview} />
      </View>
    </View>
  );
}

function collectPanesById(node: SplitNode): Map<string, SplitPane> {
  const next = new Map<string, SplitPane>();
  function visit(current: SplitNode) {
    if (current.kind === "pane") {
      next.set(current.pane.id, current.pane);
      return;
    }
    for (const child of current.group.children) {
      visit(child);
    }
  }
  visit(node);
  return next;
}

function getNodeKey(node: SplitNode): string {
  if (node.kind === "pane") {
    return node.pane.id;
  }
  return node.group.id;
}

const styles = StyleSheet.create((theme) => ({
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
  dragOverlayChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    maxWidth: 200,
  },
  dragOverlayLabel: {
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
