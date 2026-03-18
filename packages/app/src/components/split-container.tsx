import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
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
import { Platform, View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
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
import {
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import {
  useWorkspaceTabPresentation,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useWorkspaceLayoutStore, type SplitNode, type SplitPane, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";

interface SplitContainerProps {
  layout: WorkspaceLayout;
  workspaceKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  uiTabs: WorkspaceTab[];
  hoveredCloseTabKey: string | null;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  isArchivingAgent: (input: { serverId: string; agentId: string }) => boolean;
  killTerminalPending: boolean;
  killTerminalId: string | null;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCloseTabsToLeft: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onSelectNewTabOption: (selection: { optionId: "__new_tab_agent__"; paneId?: string }) => void;
  onNewTerminalTab: () => void;
  newTabAgentOptionId?: "__new_tab_agent__";
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

interface SplitNodeViewProps
  extends Omit<SplitContainerProps, "layout"> {
  node: SplitNode;
  uiTabs: WorkspaceTab[];
  focusedPaneId: string;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
}

interface SplitPaneViewProps
  extends Omit<
    SplitNodeViewProps,
    | "node"
    | "workspaceKey"
    | "focusedPaneId"
    | "activeDragTabId"
    | "showDropZones"
    | "dropPreview"
    | "onMoveTabToPane"
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

const dropCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const tabHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "workspace-tab"
  );
  if (tabHits.length > 0) {
    return tabHits;
  }

  const paneHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "split-pane-drop"
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
  uiTabs,
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  isArchivingAgent,
  killTerminalPending,
  killTerminalId,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onSelectNewTabOption,
  onNewTerminalTab,
  newTabAgentOptionId = "__new_tab_agent__",
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onMoveTabToPane,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState = () => null,
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
    })
  );

  const panesById = useMemo(() => collectPanesById(layout.root), [layout.root]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as WorkspaceTabDragData | undefined;
    if (data?.kind !== "workspace-tab") {
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
    (
      event:
        | Pick<DragMoveEvent, "active" | "over">
        | Pick<DragOverEvent, "active" | "over">
    ) => {
      const activeData = event.active.data.current as WorkspaceTabDragData | undefined;
      const overData = event.over?.data.current as
        | WorkspaceTabDragData
        | SplitPaneDropData
        | undefined;

      if (activeData?.kind !== "workspace-tab") {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      const translatedRect = event.active.rect.current.translated;
      const overRect = event.over?.rect;
      if (!translatedRect || !overRect || overRect.width <= 0 || overRect.height <= 0) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "workspace-tab") {
        const targetPane = panesById.get(overData.paneId) ?? null;
        if (!targetPane) {
          setDropPreview(null);
          setTabDropPreview(null);
          return;
        }

        const targetTabs = getWorkspacePaneDescriptors({
          pane: targetPane,
          tabs: uiTabs,
        });
        setDropPreview(null);
        setTabDropPreview(
          computeTabDropPreview({
            activePaneId: activeData.paneId,
            activeTabId: activeData.tabId,
            overPaneId: overData.paneId,
            overTabId: overData.tabId,
            targetTabs,
            activeRect: {
              left: translatedRect.left,
              width: translatedRect.width,
            },
            overRect: {
              left: overRect.left,
              width: overRect.width,
            },
          })
        );
        return;
      }

      setTabDropPreview(null);
      if (overData?.kind !== "split-pane-drop") {
        setDropPreview(null);
        return;
      }

      const centerX = translatedRect.left + translatedRect.width / 2;
      const centerY = translatedRect.top + translatedRect.height / 2;
      const relativeX = centerX - overRect.left;
      const relativeY = centerY - overRect.top;
      if (
        Number.isNaN(relativeX) ||
        Number.isNaN(relativeY) ||
        relativeX < 0 ||
        relativeX > overRect.width ||
        relativeY < 0 ||
        relativeY > overRect.height
      ) {
        setDropPreview(null);
        return;
      }

      setDropPreview({
        paneId: overData.paneId,
        position: resolveSplitDropPosition({
          width: overRect.width,
          height: overRect.height,
          x: relativeX,
          y: relativeY,
        }),
      });
    },
    [panesById, uiTabs]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = event.active.data.current as WorkspaceTabDragData | undefined;
      const overData = event.over?.data.current as
        | WorkspaceTabDragData
        | SplitPaneDropData
        | undefined;

      setActiveDragTabId(null);

      if (activeData?.kind !== "workspace-tab" || !event.over) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "workspace-tab") {
        const sourcePane = panesById.get(activeData.paneId) ?? null;
        const targetPane = panesById.get(overData.paneId) ?? null;
        if (!sourcePane || !targetPane) {
          setDropPreview(null);
          setTabDropPreview(null);
          return;
        }

        const sourceTabs = getWorkspacePaneDescriptors({ pane: sourcePane, tabs: uiTabs });
        const targetTabs = getWorkspacePaneDescriptors({ pane: targetPane, tabs: uiTabs });
        const sourceIndex = sourceTabs.findIndex((tab) => tab.tabId === activeData.tabId);
        const resolvedTabDropPreview =
          tabDropPreview?.paneId === overData.paneId ? tabDropPreview : null;
        if (sourceIndex < 0 || !resolvedTabDropPreview) {
          setDropPreview(null);
          setTabDropPreview(null);
          return;
        }

        if (activeData.paneId === overData.paneId) {
          if (sourceIndex !== resolvedTabDropPreview.insertionIndex) {
            const nextTabs = arrayMove(sourceTabs, sourceIndex, resolvedTabDropPreview.insertionIndex);
            onReorderTabsInPane(activeData.paneId, nextTabs.map((tab) => tab.tabId));
          }
          setDropPreview(null);
          setTabDropPreview(null);
          return;
        }

        const nextTargetTabIds = targetTabs.map((tab) => tab.tabId);
        nextTargetTabIds.splice(resolvedTabDropPreview.insertionIndex, 0, activeData.tabId);
        onMoveTabToPane(activeData.tabId, overData.paneId);
        onReorderTabsInPane(overData.paneId, nextTargetTabIds);
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "split-pane-drop" && dropPreview?.paneId === overData.paneId) {
        if (dropPreview.position === "center") {
          if (activeData.paneId !== overData.paneId) {
            onMoveTabToPane(activeData.tabId, overData.paneId);
          }
          setDropPreview(null);
          setTabDropPreview(null);
          return;
        }

        onSplitPane({
          tabId: activeData.tabId,
          targetPaneId: overData.paneId,
          position: dropPreview.position,
        });
      }

      setDropPreview(null);
      setTabDropPreview(null);
    },
    [dropPreview, onMoveTabToPane, onReorderTabsInPane, onSplitPane, panesById, tabDropPreview, uiTabs]
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
        node={layout.root}
        workspaceKey={workspaceKey}
        uiTabs={uiTabs}
        focusedPaneId={layout.focusedPaneId}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredTabKey={setHoveredTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        isArchivingAgent={isArchivingAgent}
        killTerminalPending={killTerminalPending}
        killTerminalId={killTerminalId}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        onCopyResumeCommand={onCopyResumeCommand}
        onCopyAgentId={onCopyAgentId}
        onCloseTabsToLeft={onCloseTabsToLeft}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseOtherTabs={onCloseOtherTabs}
        onSelectNewTabOption={onSelectNewTabOption}
        onNewTerminalTab={onNewTerminalTab}
        newTabAgentOptionId={newTabAgentOptionId}
        buildPaneContentModel={buildPaneContentModel}
        onFocusPane={onFocusPane}
        onSplitPane={onSplitPane}
        onSplitPaneEmpty={onSplitPaneEmpty}
        onMoveTabToPane={onMoveTabToPane}
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
  if (!tab) {
    return null;
  }
  const descriptor: WorkspaceTabDescriptor = {
    key: tab.tabId,
    tabId: tab.tabId,
    kind: tab.target.kind,
    target: tab.target,
  };
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
  const presentation = useWorkspaceTabPresentation({
    tab,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const label =
    presentation.titleState === "loading" ? "Loading..." : presentation.label;

  return (
    <View
      style={[
        styles.dragOverlayChip,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.borderAccent,
        },
      ]}
    >
      <WorkspaceTabIcon presentation={presentation} active size={14} />
      <Text
        numberOfLines={1}
        style={[
          styles.dragOverlayLabel,
          { color: theme.colors.foreground },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function SplitNodeView({
  node,
  workspaceKey,
  uiTabs,
  focusedPaneId,
  normalizedServerId,
  normalizedWorkspaceId,
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  isArchivingAgent,
  killTerminalPending,
  killTerminalId,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onSelectNewTabOption,
  onNewTerminalTab,
  newTabAgentOptionId,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onMoveTabToPane,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
}: SplitNodeViewProps) {
  if (node.kind === "pane") {
    return (
      <SplitPaneView
        pane={node.pane}
        uiTabs={uiTabs}
        isFocused={node.pane.id === focusedPaneId}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredTabKey={setHoveredTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        isArchivingAgent={isArchivingAgent}
        killTerminalPending={killTerminalPending}
        killTerminalId={killTerminalId}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        onCopyResumeCommand={onCopyResumeCommand}
        onCopyAgentId={onCopyAgentId}
        onCloseTabsToLeft={onCloseTabsToLeft}
        onCloseTabsToRight={onCloseTabsToRight}
        onCloseOtherTabs={onCloseOtherTabs}
        onSelectNewTabOption={onSelectNewTabOption}
        onNewTerminalTab={onNewTerminalTab}
        newTabAgentOptionId={newTabAgentOptionId}
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

  const groupSizes =
    useWorkspaceLayoutStore((state) => state.splitSizesByWorkspace[workspaceKey]?.[node.group.id]) ??
    node.group.sizes;

  return (
    <View
      style={[
        styles.group,
        node.group.direction === "horizontal" ? styles.groupHorizontal : styles.groupVertical,
      ]}
    >
      {node.group.children.map((child, index) => (
        <Fragment key={getNodeKey(child)}>
          <View style={[styles.groupChild, { flex: groupSizes[index] ?? 1 }]}>
            <SplitNodeView
              node={child}
              workspaceKey={workspaceKey}
              uiTabs={uiTabs}
              focusedPaneId={focusedPaneId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredTabKey={setHoveredTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              isArchivingAgent={isArchivingAgent}
              killTerminalPending={killTerminalPending}
              killTerminalId={killTerminalId}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onSelectNewTabOption={onSelectNewTabOption}
              onNewTerminalTab={onNewTerminalTab}
              newTabAgentOptionId={newTabAgentOptionId}
              buildPaneContentModel={buildPaneContentModel}
              onFocusPane={onFocusPane}
              onSplitPane={onSplitPane}
              onSplitPaneEmpty={onSplitPaneEmpty}
              onMoveTabToPane={onMoveTabToPane}
              onResizeSplit={onResizeSplit}
              onReorderTabsInPane={onReorderTabsInPane}
              renderPaneEmptyState={renderPaneEmptyState}
              activeDragTabId={activeDragTabId}
              showDropZones={showDropZones}
              dropPreview={dropPreview}
              tabDropPreview={tabDropPreview}
            />
          </View>
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
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  isArchivingAgent,
  killTerminalPending,
  killTerminalId,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onSelectNewTabOption,
  onNewTerminalTab,
  newTabAgentOptionId,
  buildPaneContentModel,
  onFocusPane,
  onSplitPane,
  onSplitPaneEmpty,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
}: SplitPaneViewProps) {
  const { theme } = useUnistyles();
  const paneRef = useRef<View | null>(null);
  const paneState = useMemo(
    () =>
      deriveWorkspacePaneState({
        pane,
        tabs: uiTabs,
      }),
    [pane, uiTabs]
  );
  const paneTabs = useMemo(
    () => paneState.tabs.map((tab) => tab.descriptor),
    [paneState.tabs]
  );
  const activeTabDescriptor = paneState.activeTab?.descriptor ?? null;
  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      paneTabs.map((tab) => {
        const isClosingAgent =
          tab.target.kind === "agent" &&
          isArchivingAgent({
            serverId: normalizedServerId,
            agentId: tab.target.agentId,
          });
        const isClosingTerminal =
          tab.target.kind === "terminal" &&
          killTerminalPending &&
          killTerminalId === tab.target.terminalId;

        return {
          tab,
          isActive: tab.key === activeTabDescriptor?.key,
          isCloseHovered: hoveredCloseTabKey === tab.key,
          isClosingTab: isClosingAgent || isClosingTerminal,
        };
      }),
    [
      activeTabDescriptor?.key,
      hoveredCloseTabKey,
      isArchivingAgent,
      killTerminalId,
      killTerminalPending,
      normalizedServerId,
      paneTabs,
    ]
  );
  const paneContent = useMemo(
    () =>
      activeTabDescriptor
        ? buildPaneContentModel({
            paneId: pane.id,
            tab: activeTabDescriptor,
          })
        : null,
    [
      activeTabDescriptor,
      buildPaneContentModel,
      pane.id,
    ]
  );

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    const paneElement = paneRef.current as unknown as HTMLElement | null;
    if (
      !paneElement ||
      typeof paneElement.addEventListener !== "function" ||
      typeof paneElement.removeEventListener !== "function"
    ) {
      return;
    }

    const handlePaneInteraction = () => {
      onFocusPane(pane.id);
    };

    paneElement.addEventListener("pointerdown", handlePaneInteraction, true);
    paneElement.addEventListener("focusin", handlePaneInteraction, true);

    return () => {
      paneElement.removeEventListener("pointerdown", handlePaneInteraction, true);
      paneElement.removeEventListener("focusin", handlePaneInteraction, true);
    };
  }, [onFocusPane, pane.id]);

  return (
    <View
      ref={paneRef}
      collapsable={false}
      style={styles.pane}
      onFocus={() => {
        onFocusPane(pane.id);
      }}
      onPointerDownCapture={() => {
        onFocusPane(pane.id);
      }}
    >
      <View style={styles.paneTabs}>
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
          onCloseTabsToLeft={(tabId) => onCloseTabsToLeft(tabId, paneTabs)}
          onCloseTabsToRight={(tabId) => onCloseTabsToRight(tabId, paneTabs)}
          onCloseOtherTabs={(tabId) => onCloseOtherTabs(tabId, paneTabs)}
          onSelectNewTabOption={onSelectNewTabOption}
          onNewTerminalTab={onNewTerminalTab}
          newTabAgentOptionId={newTabAgentOptionId ?? "__new_tab_agent__"}
          onReorderTabs={(nextTabs) => {
            onReorderTabsInPane(pane.id, nextTabs.map((tab) => tab.tabId));
          }}
          onSplitRight={() => onSplitPaneEmpty({ targetPaneId: pane.id, position: "right" })}
          onSplitDown={() => onSplitPaneEmpty({ targetPaneId: pane.id, position: "bottom" })}
          externalDndContext
          activeDragTabId={activeDragTabId}
          tabDropPreviewIndex={tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null}
        />
      </View>

      <View style={styles.paneContent}>
        {paneContent ? (
          <WorkspacePaneContent content={paneContent} />
        ) : (
          renderPaneEmptyState?.() ?? null
        )}
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
