import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
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
import { computeTabDropPreview, type TabDropPreview } from "./split-container-tab-drop-preview";
import { resolveSplitDropPosition, type SplitDropZoneHover } from "./split-drop-zone";
import { getWorkspacePaneDescriptors } from "@/screens/workspace/workspace-pane-state";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  collectAllPanes,
  createWorkspaceLayoutWithExplorerSidebar,
  type WorkspaceLayout,
  type SplitPane,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { panelTargetSupportsHost } from "@/plugins/workspace-panels/locations";
import { acceptsWorkspaceTabDrop } from "./workspace-tab-drag-policy";
import { WorkspaceTabDragContext } from "./workspace-tab-drag-context";
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

const EMPTY_LAYOUT = createWorkspaceLayoutWithExplorerSidebar();

interface WorkspaceTabDragScopeProps {
  children: ReactNode;
  layout: WorkspaceLayout | null;
  explorerSidebarPaneId: string | null;
  allowCrossPane: boolean;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  uiTabs: WorkspaceTab[];
  onMoveTabToPane: (tabId: string, paneId: string) => void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  onSplitPane: (input: {
    tabId: string;
    targetPaneId: string;
    position: "left" | "right" | "top" | "bottom";
  }) => void;
}
export function WorkspaceTabDragScope({
  children,
  layout,
  explorerSidebarPaneId,
  allowCrossPane,
  normalizedServerId,
  normalizedWorkspaceId,
  uiTabs,
  onMoveTabToPane,
  onReorderTabsInPane,
  onSplitPane,
}: WorkspaceTabDragScopeProps) {
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

  const panesById = useMemo(
    () => new Map(collectAllPanes((layout ?? EMPTY_LAYOUT).root).map((pane) => [pane.id, pane])),
    [layout],
  );
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

      if (
        !activeData ||
        !overData ||
        !acceptsWorkspaceTabDrop(allowCrossPane, activeData.paneId, overData)
      ) {
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

      const activeTab = uiTabs.find((tab) => tab.tabId === activeData.tabId) ?? null;
      const destinationPaneId =
        overData?.kind === "workspace-tab" || overData?.kind === "split-pane-drop"
          ? overData.paneId
          : null;
      const destinationHost = destinationPaneId === explorerSidebarPaneId ? "explorer" : "main";
      if (
        !activeTab ||
        !panelTargetSupportsHost(normalizedServerId, activeTab.target, destinationHost)
      ) {
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
    [allowCrossPane, normalizedServerId, panesById, explorerSidebarPaneId, uiTabs],
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

      if (
        activeData &&
        overData &&
        event.over &&
        acceptsWorkspaceTabDrop(allowCrossPane, activeData.paneId, overData)
      ) {
        if (overData?.kind === "workspace-tab") {
          applyTabDropEnd({ activeData, overData });
        } else if (overData?.kind === "split-pane-drop") {
          applyPaneDropEnd({ activeData, overData });
        }
      }

      setDropPreview(null);
      setTabDropPreview(null);
    },
    [allowCrossPane, applyTabDropEnd, applyPaneDropEnd],
  );

  const context = useMemo(
    () => ({ activeDragTabId, dropPreview, tabDropPreview, externalDndContext: true }),
    [activeDragTabId, dropPreview, tabDropPreview],
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
      <WorkspaceTabDragContext value={context}>{children}</WorkspaceTabDragContext>
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
  const { t } = useTranslation();
  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const label =
          presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;

        return (
          <View style={styles.dragOverlayChip}>
            <WorkspaceTabIcon presentation={presentation} active size={14} backdrop="surface1" />
            <Text numberOfLines={1} style={styles.dragOverlayLabel}>
              {label}
            </Text>
          </View>
        );
      }}
    </WorkspaceTabPresentationResolver>
  );
}

const styles = StyleSheet.create((theme) => ({
  dragOverlayChip: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
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
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
}));
