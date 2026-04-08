import AsyncStorage from "@react-native-async-storage/async-storage";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ellipsis, Grid3x3, Group, Maximize2, Minus, Plus, Search, Ungroup, X } from "lucide-react-native";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { WorkspacePaneContent, type WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import { WorkspaceActionsMenu } from "@/screens/workspace/workspace-actions-menu";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

type CanvasPanelPosition = {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

type CanvasGroup = {
  groupId: string;
  tabIds: string[];
  label: string;
};

type CanvasWorkspaceState = {
  panelPositions: Record<string, CanvasPanelPosition>;
  canvasOffset: { x: number; y: number };
  cameraZoom: number;
  canvasScale: number;
  snapEnabled: boolean;
  groups?: CanvasGroup[];
};

type DragState =
  | {
      type: "panel";
      tabId: string;
      pointerId: number;
      originX: number;
      originY: number;
      startX: number;
      startY: number;
    }
  | {
      type: "resize";
      tabId: string;
      pointerId: number;
      originWidth: number;
      originHeight: number;
      startX: number;
      startY: number;
    }
  | {
      type: "select";
      pointerId: number;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | {
      type: "canvas";
      pointerId: number;
      originX: number;
      originY: number;
      startX: number;
      startY: number;
    }
  | {
      type: "group";
      groupId: string;
      pointerId: number;
      origins: Record<string, { x: number; y: number }>;
      startX: number;
      startY: number;
    };

interface WorkspaceCanvasSurfaceProps {
  tabs: WorkspaceTabDescriptor[];
  activeTabId: string | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  buildPaneContentModel: (input: {
    tab: WorkspaceTabDescriptor;
    paneId: string;
    isPaneFocused: boolean;
  }) => WorkspacePaneContentModel;
  onCloseTab: (tabId: string) => void;
  onCreateAgent: () => void;
  onCreateBrowser: () => void;
  onCreateTerminal: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName?: (() => void) | null;
  canCopyWorkspacePath: boolean;
  createTerminalPending?: boolean;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.1;
const DEFAULT_PANEL_WIDTH = 560;
const DEFAULT_PANEL_HEIGHT = 420;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 220;
const PANEL_CASCADE_X = 44;
const PANEL_CASCADE_Y = 36;
const GRID_SIZE = 24;
const ALIGN_TOLERANCE = 10;

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function maybeSnapToGrid(value: number, enabled: boolean): number {
  return enabled ? snapToGrid(value) : value;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value.toFixed(2))));
}

const workspaceCanvasStateCache = new Map<string, CanvasWorkspaceState>();

function buildCanvasStorageKey(workspaceCanvasKey: string): string {
  return `paseo:workspace-canvas:${workspaceCanvasKey}`;
}

function SelectionToolbar({
  selectedTabIds,
  groups,
  theme,
  onGroup,
  onUngroup,
  onClear,
}: {
  selectedTabIds: string[];
  groups: CanvasGroup[];
  theme: { colors: Record<string, any>; borderRadius: Record<string, any>; borderWidth: Record<string, any> };
  onGroup: (tabIds: string[]) => void;
  onUngroup: (groupId: string) => void;
  onClear: () => void;
}) {
  const existingGroup = groups.find(
    (g) =>
      selectedTabIds.length === g.tabIds.length &&
      selectedTabIds.every((id) => g.tabIds.includes(id)),
  );

  return (
    <View
      style={selToolbarStyles.wrap}
      onPointerDown={(e: any) => e.stopPropagation()}
      onPointerUp={(e: any) => e.stopPropagation()}
    >
      <View style={selToolbarStyles.bar}>
        <Text style={selToolbarStyles.count}>{selectedTabIds.length} selected</Text>
        {existingGroup ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onUngroup(existingGroup.groupId)}
            style={({ hovered, pressed }) => [
              selToolbarStyles.button,
              (hovered || pressed) && selToolbarStyles.buttonHovered,
            ]}
          >
            <Ungroup size={14} color={theme.colors.foreground} />
            <Text style={selToolbarStyles.buttonText}>Ungroup</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => onGroup(selectedTabIds)}
            style={({ hovered, pressed }) => [
              selToolbarStyles.button,
              selToolbarStyles.buttonPrimary,
              (hovered || pressed) && selToolbarStyles.buttonPrimaryHovered,
            ]}
          >
            <Group size={14} color="#fff" />
            <Text style={selToolbarStyles.buttonPrimaryText}>Group</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={onClear}
          style={({ hovered, pressed }) => [
            selToolbarStyles.button,
            (hovered || pressed) && selToolbarStyles.buttonHovered,
          ]}
        >
          <X size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
  );
}

const selToolbarStyles = StyleSheet.create((theme) => ({
  wrap: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    zIndex: 10000,
    alignItems: "center",
    pointerEvents: "box-none" as any,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  count: {
    fontSize: 11,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: 8,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.md,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  buttonText: {
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  buttonPrimary: {
    backgroundColor: theme.colors.accent,
  },
  buttonPrimaryHovered: {
    opacity: 0.85,
  },
  buttonPrimaryText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ffffff",
  },
}));


function buildDefaultPanelPosition(index: number): CanvasPanelPosition {
  return {
    x: snapToGrid(48 + (index % 4) * PANEL_CASCADE_X),
    y: snapToGrid(48 + (index % 4) * PANEL_CASCADE_Y),
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    zIndex: index + 1,
  };
}

export const WorkspaceCanvasSurface = memo(function WorkspaceCanvasSurface({
  tabs,
  activeTabId,
  normalizedServerId,
  normalizedWorkspaceId,
  buildPaneContentModel,
  onCloseTab,
  onCreateAgent,
  onCreateBrowser,
  onCreateTerminal,
  onCopyWorkspacePath,
  onCopyBranchName,
  canCopyWorkspacePath,
  createTerminalPending = false,
}: WorkspaceCanvasSurfaceProps) {
  const { theme } = useUnistyles();
  const workspaceCanvasKey = `${normalizedServerId}:${normalizedWorkspaceId}`;
  const initialCanvasStateRef = useRef<CanvasWorkspaceState | null>(
    workspaceCanvasStateCache.get(workspaceCanvasKey) ?? null,
  );
  const [panelPositions, setPanelPositions] = useState<Record<string, CanvasPanelPosition>>(
    () => initialCanvasStateRef.current?.panelPositions ?? {},
  );
  const [canvasOffset, setCanvasOffset] = useState(
    () => initialCanvasStateRef.current?.canvasOffset ?? { x: 0, y: 0 },
  );
  const [cameraZoom, setCameraZoom] = useState(() => initialCanvasStateRef.current?.cameraZoom ?? 1);
  const [canvasScale, setCanvasScale] = useState(() => initialCanvasStateRef.current?.canvasScale ?? 1);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(() => initialCanvasStateRef.current?.snapEnabled ?? true);
  const [groups, setGroups] = useState<CanvasGroup[]>(() => initialCanvasStateRef.current?.groups ?? []);
  const [selectedTabIds, setSelectedTabIds] = useState<string[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupLabel, setEditingGroupLabel] = useState("");
  const groupLabelTapRef = useRef<Record<string, number>>({});

  const commitGroupLabel = useCallback(() => {
    if (!editingGroupId) return;
    const trimmed = editingGroupLabel.trim();
    if (trimmed) {
      setGroups((prev) =>
        prev.map((g) => (g.groupId === editingGroupId ? { ...g, label: trimmed } : g)),
      );
    }
    setEditingGroupId(null);
    setEditingGroupLabel("");
  }, [editingGroupId, editingGroupLabel]);
  const [alignmentGuide, setAlignmentGuide] = useState<{ x?: number; y?: number }>({});
  const rootRef = useRef<any>(null);
  const panelNodeRefs = useRef(new Map<string, HTMLElement>());
  const hasLoadedPersistedStateRef = useRef(false);
  const nextZIndexRef = useRef(1);

  useEffect(() => {
    const latestCachedState = workspaceCanvasStateCache.get(workspaceCanvasKey) ?? initialCanvasStateRef.current;
    setPanelPositions((current) => {
      const next: Record<string, CanvasPanelPosition> = {};
      let changed = false;

      tabs.forEach((tab, index) => {
        const existing = current[tab.tabId] ?? latestCachedState?.panelPositions?.[tab.tabId];
        if (existing) {
          next[tab.tabId] = existing;
          nextZIndexRef.current = Math.max(nextZIndexRef.current, existing.zIndex + 1);
          return;
        }
        const seeded = buildDefaultPanelPosition(index);
        next[tab.tabId] = seeded;
        nextZIndexRef.current = Math.max(nextZIndexRef.current, seeded.zIndex + 1);
        changed = true;
      });

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (currentKeys.length !== nextKeys.length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [tabs, workspaceCanvasKey]);

  useEffect(() => {
    const nextState = {
      panelPositions,
      canvasOffset,
      cameraZoom,
      canvasScale,
      snapEnabled,
      groups,
    } satisfies CanvasWorkspaceState;
    workspaceCanvasStateCache.set(workspaceCanvasKey, nextState);
    if (!hasLoadedPersistedStateRef.current) {
      return;
    }
    void AsyncStorage.setItem(buildCanvasStorageKey(workspaceCanvasKey), JSON.stringify(nextState));
  }, [cameraZoom, canvasOffset, canvasScale, groups, panelPositions, snapEnabled, workspaceCanvasKey]);

  useEffect(() => {
    let cancelled = false;

    const loadPersistedState = async () => {
      try {
        const raw = await AsyncStorage.getItem(buildCanvasStorageKey(workspaceCanvasKey));
        if (!raw || cancelled) {
          hasLoadedPersistedStateRef.current = true;
          return;
        }
        const parsed = JSON.parse(raw) as Partial<CanvasWorkspaceState>;
        const restored: CanvasWorkspaceState = {
          panelPositions: parsed.panelPositions ?? {},
          canvasOffset: parsed.canvasOffset ?? { x: 0, y: 0 },
          cameraZoom: typeof parsed.cameraZoom === "number" ? parsed.cameraZoom : 1,
          canvasScale: typeof parsed.canvasScale === "number" ? parsed.canvasScale : 1,
          snapEnabled: typeof parsed.snapEnabled === "boolean" ? parsed.snapEnabled : true,
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        };
        workspaceCanvasStateCache.set(workspaceCanvasKey, restored);
        initialCanvasStateRef.current = restored;
        setPanelPositions((current) => {
          // Merge: restored positions win, but keep any current positions for tabs not in restored
          const merged = { ...current };
          for (const [tabId, pos] of Object.entries(restored.panelPositions)) {
            merged[tabId] = pos;
            nextZIndexRef.current = Math.max(nextZIndexRef.current, pos.zIndex + 1);
          }
          return merged;
        });
        setCanvasOffset(restored.canvasOffset);
        setCameraZoom(restored.cameraZoom);
        setCanvasScale(restored.canvasScale);
        setSnapEnabled(restored.snapEnabled);
        setGroups(restored.groups ?? []);
      } catch {
        // ignore corrupt canvas state
      } finally {
        if (!cancelled) {
          hasLoadedPersistedStateRef.current = true;
        }
      }
    };

    void loadPersistedState();

    return () => {
      cancelled = true;
    };
  }, [workspaceCanvasKey]);

  useEffect(() => {
    const latestCachedState = workspaceCanvasStateCache.get(workspaceCanvasKey);
    if (latestCachedState && latestCachedState.snapEnabled !== snapEnabled) {
      setSnapEnabled(latestCachedState.snapEnabled);
    }
  }, [workspaceCanvasKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return;
        }
        setSpacePressed(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setSpacePressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      const worldScale = Math.max(0.0001, canvasScale * cameraZoom);
      const worldDx = dx / worldScale;
      const worldDy = dy / worldScale;

      if (dragState.type === "panel") {
        setPanelPositions((current) => {
          const panel = current[dragState.tabId];
          if (!panel) {
            return current;
          }
          let nextX = maybeSnapToGrid(dragState.originX + worldDx, snapEnabled);
          let nextY = maybeSnapToGrid(dragState.originY + worldDy, snapEnabled);
          let guideX: number | undefined;
          let guideY: number | undefined;
          const nextCenterX = nextX + panel.width / 2;
          const nextCenterY = nextY + panel.height / 2;

          Object.entries(current).forEach(([otherId, other]) => {
            if (otherId === dragState.tabId) return;
            const candidatesX = [other.x, other.x + other.width / 2, other.x + other.width];
            const candidatesY = [other.y, other.y + other.height / 2, other.y + other.height];
            candidatesX.forEach((candidate) => {
              if (Math.abs(candidate - nextX) <= ALIGN_TOLERANCE) {
                nextX = candidate;
                guideX = candidate;
              }
              if (Math.abs(candidate - nextCenterX) <= ALIGN_TOLERANCE) {
                nextX = candidate - panel.width / 2;
                guideX = candidate;
              }
            });
            candidatesY.forEach((candidate) => {
              if (Math.abs(candidate - nextY) <= ALIGN_TOLERANCE) {
                nextY = candidate;
                guideY = candidate;
              }
              if (Math.abs(candidate - nextCenterY) <= ALIGN_TOLERANCE) {
                nextY = candidate - panel.height / 2;
                guideY = candidate;
              }
            });
          });

          setAlignmentGuide({ x: guideX, y: guideY });
          return {
            ...current,
            [dragState.tabId]: {
              ...panel,
              x: nextX,
              y: nextY,
            },
          };
        });
        return;
      }

      if (dragState.type === "select") {
        const rootNode = rootRef.current as HTMLElement | null;
        const rootRect = rootNode?.getBoundingClientRect?.();
        const oX = rootRect?.left ?? 0;
        const oY = rootRect?.top ?? 0;
        setDragState((current) =>
          current?.type === "select"
            ? { ...current, currentX: event.clientX - oX, currentY: event.clientY - oY }
            : current,
        );
        return;
      }

      if (dragState.type === "resize") {
        setPanelPositions((current) => {
          const panel = current[dragState.tabId];
          if (!panel) {
            return current;
          }
          return {
            ...current,
            [dragState.tabId]: {
              ...panel,
              width: Math.max(MIN_PANEL_WIDTH, maybeSnapToGrid(dragState.originWidth + worldDx, snapEnabled)),
              height: Math.max(MIN_PANEL_HEIGHT, maybeSnapToGrid(dragState.originHeight + worldDy, snapEnabled)),
            },
          };
        });
        return;
      }

      if (dragState.type === "group") {
        setPanelPositions((current) => {
          const next = { ...current };
          for (const [tabId, origin] of Object.entries(dragState.origins)) {
            const panel = current[tabId];
            if (!panel) continue;
            next[tabId] = {
              ...panel,
              x: maybeSnapToGrid(origin.x + worldDx, snapEnabled),
              y: maybeSnapToGrid(origin.y + worldDy, snapEnabled),
            };
          }
          return next;
        });
        return;
      }

      setCanvasOffset({
        x: dragState.originX + dx,
        y: dragState.originY + dy,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }
      if (dragState.type === "select") {
        const sw = Math.abs(dragState.currentX - dragState.startX);
        const sh = Math.abs(dragState.currentY - dragState.startY);
        // Only process selection if drag was a real rectangle, not a click
        if (sw > 8 || sh > 8) {
          const rootNode = rootRef.current as HTMLElement | null;
          const rootRect = rootNode?.getBoundingClientRect();
          const rLeft = rootRect?.left ?? 0;
          const rTop = rootRect?.top ?? 0;
          const minX = Math.min(dragState.startX, dragState.currentX);
          const maxX = Math.max(dragState.startX, dragState.currentX);
          const minY = Math.min(dragState.startY, dragState.currentY);
          const maxY = Math.max(dragState.startY, dragState.currentY);
          const selected: string[] = [];
          panelNodeRefs.current.forEach((node, tabId) => {
            const rect = node.getBoundingClientRect();
            const left = rect.left - rLeft;
            const top = rect.top - rTop;
            const right = rect.right - rLeft;
            const bottom = rect.bottom - rTop;
            if (right >= minX && left <= maxX && bottom >= minY && top <= maxY) {
              selected.push(tabId);
            }
          });
          setSelectedTabIds(selected);
        }
      }
      setAlignmentGuide({});
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [cameraZoom, canvasOffset, canvasScale, dragState, panelPositions, snapEnabled]);


  const canvasContentModelsRef = useRef(new Map<string, WorkspacePaneContentModel>());
  const canvasContentModels = useMemo(() => {
    const prev = canvasContentModelsRef.current;
    const next = new Map<string, WorkspacePaneContentModel>();
    const tabIds = new Set(tabs.map((tab) => tab.tabId));

    // Reuse existing models for tabs that haven't changed
    tabs.forEach((tab) => {
      const existing = prev.get(tab.tabId);
      if (existing) {
        next.set(tab.tabId, existing);
      } else {
        next.set(
          tab.tabId,
          buildPaneContentModel({
            tab,
            paneId: `canvas:${tab.tabId}`,
            isPaneFocused: true,
          }),
        );
      }
    });

    canvasContentModelsRef.current = next;
    return next;
  }, [buildPaneContentModel, tabs]);

  const cameraZoomPercent = Math.round(cameraZoom * 100);
  const canvasScalePercent = Math.round(canvasScale * 100);

  const updateCameraZoom = (nextZoom: number) => {
    const rootEl = rootRef.current as HTMLElement | null;
    const w = rootEl?.clientWidth ?? 800;
    const h = rootEl?.clientHeight ?? 600;
    const cx = w / 2;
    const cy = h / 2;
    const oldZoom = cameraZoom;
    const newZoom = clampZoom(nextZoom);
    const worldX = (cx - canvasOffset.x) / (canvasScale * oldZoom);
    const worldY = (cy - canvasOffset.y) / (canvasScale * oldZoom);
    setCameraZoom(newZoom);
    setCanvasOffset({
      x: cx - worldX * canvasScale * newZoom,
      y: cy - worldY * canvasScale * newZoom,
    });
  };

  const updateCanvasScale = (nextScale: number) => {
    const rootEl = rootRef.current as HTMLElement | null;
    const w = rootEl?.clientWidth ?? 800;
    const h = rootEl?.clientHeight ?? 600;
    const cx = w / 2;
    const cy = h / 2;
    const oldScale = canvasScale;
    const newScale = clampZoom(nextScale);
    const worldX = (cx - canvasOffset.x) / oldScale;
    const worldY = (cy - canvasOffset.y) / oldScale;
    setCanvasScale(newScale);
    setCanvasOffset({
      x: cx - worldX * newScale,
      y: cy - worldY * newScale,
    });
  };

  useEffect(() => {
    const node = rootRef.current as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") {
      return;
    }

    const handleSelectStart = (event: Event) => {
      const rawTarget = event.target as { closest?: (selector: string) => Element | null } | null;
      const allowTextSelection =
        rawTarget && typeof rawTarget.closest === "function"
          ? rawTarget.closest(
              'input, textarea, [contenteditable="true"], p, span, li, pre, code, h1, h2, h3, h4, h5, h6, label, [data-allow-text-select="true"]',
            )
          : null;
      if (!allowTextSelection) {
        event.preventDefault();
      }
    };

    const handleWheel = (event: WheelEvent) => {
      const { ctrlKey, metaKey, deltaY } = event;
      if (!ctrlKey && !metaKey) {
        return;
      }
      event.preventDefault();
      const direction = deltaY > 0 ? -1 : 1;

      const rootEl = rootRef.current as HTMLElement | null;
      const rootRect = rootEl?.getBoundingClientRect();
      const pointerX = event.clientX - (rootRect?.left ?? 0);
      const pointerY = event.clientY - (rootRect?.top ?? 0);

      if (metaKey) {
        const oldScale = canvasScale;
        const newScale = clampZoom(canvasScale + direction * ZOOM_STEP);
        // Adjust offset so the point under the cursor stays fixed
        // pointerX = canvasOffset.x + worldX * oldScale  =>  worldX = (pointerX - canvasOffset.x) / oldScale
        // pointerX = newOffset.x + worldX * newScale      =>  newOffset.x = pointerX - worldX * newScale
        const worldX = (pointerX - canvasOffset.x) / oldScale;
        const worldY = (pointerY - canvasOffset.y) / oldScale;
        setCanvasScale(newScale);
        setCanvasOffset({
          x: pointerX - worldX * newScale,
          y: pointerY - worldY * newScale,
        });
        return;
      }
      if (ctrlKey) {
        const oldZoom = cameraZoom;
        const newZoom = clampZoom(cameraZoom + direction * ZOOM_STEP);
        const worldX = (pointerX - canvasOffset.x) / (canvasScale * oldZoom);
        const worldY = (pointerY - canvasOffset.y) / (canvasScale * oldZoom);
        setCameraZoom(newZoom);
        setCanvasOffset({
          x: pointerX - worldX * canvasScale * newZoom,
          y: pointerY - worldY * canvasScale * newZoom,
        });
      }
    };

    node.addEventListener("selectstart", handleSelectStart);
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      node.removeEventListener("selectstart", handleSelectStart);
      node.removeEventListener("wheel", handleWheel);
    };
  }, [cameraZoom, canvasScale]);

  const bringPanelToFront = (tabId: string) => {
    const nextZIndex = nextZIndexRef.current++;
    setPanelPositions((current) => {
      const panel = current[tabId];
      if (!panel || panel.zIndex === nextZIndex) {
        return current;
      }
      return {
        ...current,
        [tabId]: {
          ...panel,
          zIndex: nextZIndex,
        },
      };
    });
  };

  return (
    <View
      ref={rootRef}
      style={[styles.root, (spacePressed || dragState?.type === "canvas") && styles.rootPanning]}
      {...({
        onContextMenu: (event: any) => {
          if (dragState?.type === "canvas") {
            event.preventDefault();
          }
        },
      } as any)}
      onPointerDown={(event) => {
        const shouldPan = spacePressed || event.nativeEvent.button === 2;
        if (shouldPan) {
          event.preventDefault();
          setDragState({
            type: "canvas",
            pointerId: event.nativeEvent.pointerId,
            originX: canvasOffset.x,
            originY: canvasOffset.y,
            startX: event.nativeEvent.clientX,
            startY: event.nativeEvent.clientY,
          });
          return;
        }
        if (event.nativeEvent.button !== 0) {
          return;
        }
        const rootNode = rootRef.current as HTMLElement | null;
        const rootRect = rootNode?.getBoundingClientRect?.();
        const offsetX = rootRect?.left ?? 0;
        const offsetY = rootRect?.top ?? 0;
        setDragState({
          type: "select",
          pointerId: event.nativeEvent.pointerId,
          startX: event.nativeEvent.clientX - offsetX,
          startY: event.nativeEvent.clientY - offsetY,
          currentX: event.nativeEvent.clientX - offsetX,
          currentY: event.nativeEvent.clientY - offsetY,
        });
      }}
    >
      <View
        style={[
          styles.worldLayer,
          {
            transform: [
              { translateX: canvasOffset.x },
              { translateY: canvasOffset.y },
              { scale: canvasScale },
            ],
          },
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.grid,
            {
              transform: [{ scale: cameraZoom }],
            },
          ]}
        />
        {groups.map((group) => {
          const groupPanelEntries = group.tabIds
            .map((id) => ({ id, pos: panelPositions[id] }))
            .filter((e): e is { id: string; pos: CanvasPanelPosition } => Boolean(e.pos));
          if (groupPanelEntries.length < 2) return null;
          const gx = Math.min(...groupPanelEntries.map((e) => e.pos.x));
          const gy = Math.min(...groupPanelEntries.map((e) => e.pos.y));
          const gr = Math.max(...groupPanelEntries.map((e) => e.pos.x + e.pos.width));
          const gb = Math.max(...groupPanelEntries.map((e) => e.pos.y + e.pos.height));
          const pad = 24;
          const minZ = Math.min(...groupPanelEntries.map((e) => e.pos.zIndex)) - 1;
          return (
            <View
              key={group.groupId}
              style={[
                styles.groupBounds,
                {
                  left: (gx - pad) * cameraZoom,
                  top: (gy - pad) * cameraZoom,
                  width: (gr - gx + pad * 2) * cameraZoom,
                  height: (gb - gy + pad * 2) * cameraZoom,
                  zIndex: Math.max(0, minZ),
                },
              ]}
              onPointerDown={(event) => {
                if (spacePressed || event.nativeEvent.button !== 0) return;
                event.stopPropagation();
                const origins: Record<string, { x: number; y: number }> = {};
                for (const e of groupPanelEntries) {
                  origins[e.id] = { x: e.pos.x, y: e.pos.y };
                }
                setDragState({
                  type: "group",
                  groupId: group.groupId,
                  pointerId: event.nativeEvent.pointerId,
                  origins,
                  startX: event.nativeEvent.clientX,
                  startY: event.nativeEvent.clientY,
                });
              }}
            >
              <View
                style={[styles.groupLabelRow, { transform: [{ scale: 1 / (canvasScale * cameraZoom) }] }]}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Group size={11} color={String(theme.colors.accent)} />
                {editingGroupId === group.groupId ? (
                  <TextInput
                    autoFocus
                    value={editingGroupLabel}
                    onChangeText={setEditingGroupLabel}
                    onSubmitEditing={commitGroupLabel}
                    onBlur={commitGroupLabel}
                    style={[styles.groupLabelInput, { color: String(theme.colors.accent), outlineStyle: "none" } as any]}
                    selectTextOnFocus
                  />
                ) : (
                  <Text
                    style={styles.groupLabel}
                    onPress={() => {
                      const now = Date.now();
                      const lastTap = (groupLabelTapRef.current as any)?.[group.groupId] ?? 0;
                      (groupLabelTapRef.current as any)[group.groupId] = now;
                      if (now - lastTap < 400) {
                        setEditingGroupId(group.groupId);
                        setEditingGroupLabel(group.label);
                        (groupLabelTapRef.current as any)[group.groupId] = 0;
                      }
                    }}
                  >
                    {group.label}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
        {tabs.map((tab) => {
          const panel = panelPositions[tab.tabId] ?? buildDefaultPanelPosition(0);
          const model = canvasContentModels.get(tab.tabId);
          if (!model) {
            return null;
          }

          return (
            <View
              key={tab.tabId}
              ref={(node: any) => {
                if (node) panelNodeRefs.current.set(tab.tabId, node as HTMLElement);
                else panelNodeRefs.current.delete(tab.tabId);
              }}
              style={[
                styles.panel,
                {
                  left: panel.x * cameraZoom,
                  top: panel.y * cameraZoom,
                  width: panel.width * cameraZoom,
                  height: panel.height * cameraZoom,
                  zIndex: panel.zIndex,
                },
                activeTabId === tab.tabId ? styles.panelActive : null,
                selectedTabIds.includes(tab.tabId) ? styles.panelSelected : null,
              ]}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (spacePressed || event.nativeEvent.button === 2) {
                  return;
                }
                bringPanelToFront(tab.tabId);
                setSelectedTabIds([tab.tabId]);
              }}
            >
            <View
              style={styles.panelHeader}
              onPointerDown={(event) => {
                if (spacePressed || event.nativeEvent.button === 2) {
                  return;
                }
                event.stopPropagation();
                bringPanelToFront(tab.tabId);
                setDragState({
                  type: "panel",
                  tabId: tab.tabId,
                  pointerId: event.nativeEvent.pointerId,
                  originX: panel.x,
                  originY: panel.y,
                  startX: event.nativeEvent.clientX,
                  startY: event.nativeEvent.clientY,
                });
              }}
            >
              <WorkspaceTabPresentationResolver
                tab={tab}
                serverId={normalizedServerId}
                workspaceId={normalizedWorkspaceId}
              >
                {(presentation) => (
                  <>
                    <View style={styles.panelTitleRow}>
                      <View style={styles.panelIconWrap}>
                        <WorkspaceTabIcon presentation={presentation} active={activeTabId === tab.tabId} />
                      </View>
                      <View style={styles.panelTitleTextWrap}>
                        <Text numberOfLines={1} style={styles.panelTitle}>
                          {presentation.titleState === "loading" ? "Loading..." : presentation.label}
                        </Text>
                        <Text numberOfLines={1} style={styles.panelSubtitle}>
                          {presentation.subtitle}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Close panel"
                      hitSlop={8}
                      onPress={() => onCloseTab(tab.tabId)}
                      style={({ hovered, pressed }) => [
                        styles.closeButton,
                        (hovered || pressed) && styles.closeButtonHovered,
                      ]}
                    >
                      <Text style={styles.closeButtonText}>×</Text>
                    </Pressable>
                  </>
                )}
              </WorkspaceTabPresentationResolver>
            </View>
            <View style={styles.panelBody} pointerEvents={dragState ? "none" : "auto"}>
              <WorkspacePaneContent content={model} />
            </View>
            <View
              style={[styles.resizeHandle, { cursor: "nwse-resize" } as any]}
              onPointerDown={(event) => {
                if (spacePressed || event.nativeEvent.button === 2) {
                  return;
                }
                event.stopPropagation();
                bringPanelToFront(tab.tabId);
                setDragState({
                  type: "resize",
                  tabId: tab.tabId,
                  pointerId: event.nativeEvent.pointerId,
                  originWidth: panel.width,
                  originHeight: panel.height,
                  startX: event.nativeEvent.clientX,
                  startY: event.nativeEvent.clientY,
                });
              }}
            >
              <View style={styles.resizeHandleGrip} />
            </View>
            </View>
          );
        })}
      </View>
      {dragState?.type === "select" && (() => {
        const sx = Math.min(dragState.startX, dragState.currentX);
        const sy = Math.min(dragState.startY, dragState.currentY);
        const sw = Math.abs(dragState.currentX - dragState.startX);
        const sh = Math.abs(dragState.currentY - dragState.startY);
        return sw > 4 || sh > 4 ? (
          <View
            pointerEvents="none"
            style={[
              styles.selectionRect,
              { left: sx, top: sy, width: sw, height: sh },
            ]}
          />
        ) : null;
      })()}
      {selectedTabIds.length >= 2 && !dragState ? (
        <SelectionToolbar
          selectedTabIds={selectedTabIds}
          groups={groups}
          theme={theme}
          onGroup={(tabIds) => {
            const groupId =
              typeof globalThis.crypto?.randomUUID === "function"
                ? globalThis.crypto.randomUUID()
                : `g-${Date.now()}`;
            setGroups((prev) => [
              ...prev,
              { groupId, tabIds: [...tabIds], label: `Group ${prev.length + 1}` },
            ]);
            setSelectedTabIds([]);
          }}
          onUngroup={(groupId) => {
            setGroups((prev) => prev.filter((g) => g.groupId !== groupId));
            setSelectedTabIds([]);
          }}
          onClear={() => setSelectedTabIds([])}
        />
      ) : null}
      <View style={styles.topControls} onPointerDown={(e) => e.stopPropagation()}>
        <WorkspaceActionsMenu
          triggerTestID="workspace-canvas-menu-trigger"
          menuTestID="workspace-canvas-menu"
          newAgentTestID="workspace-canvas-new-agent"
          newBrowserTestID="workspace-canvas-new-browser"
          newTerminalTestID="workspace-canvas-new-terminal"
          copyPathTestID="workspace-canvas-copy-path"
          copyBranchNameTestID="workspace-canvas-copy-branch-name"
          onCreateAgent={onCreateAgent}
          onCreateBrowser={onCreateBrowser}
          onCreateTerminal={onCreateTerminal}
          onCopyWorkspacePath={onCopyWorkspacePath}
          onCopyBranchName={onCopyBranchName}
          canCopyWorkspacePath={canCopyWorkspacePath}
          createTerminalPending={createTerminalPending}
          align="end"
        >
          {({ hovered, open }) => (
            <View style={[styles.topMenuButton, (hovered || open) && styles.topMenuButtonActive]}>
              <Ellipsis
                size={theme.iconSize.md}
                color={hovered || open ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            </View>
          )}
        </WorkspaceActionsMenu>
      </View>
      <View style={styles.zoomControls} onPointerDown={(e) => e.stopPropagation()}>
        <View style={styles.zoomGroup}>
          <Search size={12} color={theme.colors.foregroundMuted} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            onPress={() => updateCameraZoom(cameraZoom - ZOOM_STEP)}
            style={({ hovered, pressed }) => [styles.zoomButton, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Minus size={12} color={theme.colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset zoom to one hundred percent"
            onPress={() => updateCameraZoom(1)}
            style={({ hovered, pressed }) => [styles.zoomReadout, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Text style={styles.zoomReadoutText}>{cameraZoomPercent}%</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            onPress={() => updateCameraZoom(cameraZoom + ZOOM_STEP)}
            style={({ hovered, pressed }) => [styles.zoomButton, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Plus size={12} color={theme.colors.foreground} />
          </Pressable>
        </View>
        <View style={styles.zoomDivider} />
        <View style={styles.zoomGroup}>
          <Maximize2 size={12} color={theme.colors.foregroundMuted} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scale out"
            onPress={() => updateCanvasScale(canvasScale - ZOOM_STEP)}
            style={({ hovered, pressed }) => [styles.zoomButton, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Minus size={12} color={theme.colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset canvas scale to one hundred percent"
            onPress={() => updateCanvasScale(1)}
            style={({ hovered, pressed }) => [styles.zoomReadout, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Text style={styles.zoomReadoutText}>{canvasScalePercent}%</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scale in"
            onPress={() => updateCanvasScale(canvasScale + ZOOM_STEP)}
            style={({ hovered, pressed }) => [styles.zoomButton, (hovered || pressed) && styles.zoomButtonHovered]}
          >
            <Plus size={12} color={theme.colors.foreground} />
          </Pressable>
        </View>
        <View style={styles.zoomDivider} />
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Toggle snap to grid"
          accessibilityState={{ checked: snapEnabled }}
          onPress={() => setSnapEnabled((current) => !current)}
          style={({ hovered, pressed }) => [
            styles.snapToggle,
            snapEnabled && styles.snapToggleActive,
            (hovered || pressed) && styles.zoomButtonHovered,
          ]}
        >
          <Grid3x3 size={12} color={snapEnabled ? theme.colors.foreground : theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceWorkspace,
    contain: "layout style paint",
  },
  rootPanning: {
    cursor: "pointer",
  },
  worldLayer: {
    ...StyleSheet.absoluteFillObject,
    willChange: "transform",
    backfaceVisibility: "hidden",
  },
  grid: {
    position: "absolute",
    left: "-50%",
    top: "-50%",
    width: "200%",
    height: "200%",
    backgroundColor: theme.colors.surfaceWorkspace,
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
    backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
    willChange: "transform",
    backfaceVisibility: "hidden",
  },
  topControls: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[3],
    zIndex: 2000,
    flexDirection: "row",
    alignItems: "center",
  },
  topMenuButton: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  topMenuButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  zoomControls: {
    position: "absolute",
    right: theme.spacing[3],
    bottom: theme.spacing[3],
    zIndex: 2000,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  zoomGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  zoomDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: theme.colors.border,
  },
  snapToggle: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  snapToggleActive: {
    backgroundColor: theme.colors.surface3,
  },
  zoomButton: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  zoomReadout: {
    minWidth: 44,
    height: 26,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  zoomButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  zoomReadoutText: {
    fontSize: 10,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  panel: {
    position: "absolute",
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    overflow: "hidden",
    willChange: "transform, width, height",
    backfaceVisibility: "hidden",
    contain: "layout paint style",
  },
  panelActive: {
    borderColor: theme.colors.accent,
  },
  panelSelected: {
    borderColor: theme.colors.foreground,
  },
  panelHeader: {
    height: 44,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  panelTitleRow: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  panelIconWrap: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitleTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  panelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    lineHeight: 14,
  },
  panelSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    lineHeight: 12,
    marginTop: 0,
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  closeButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  closeButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: 18,
    lineHeight: 18,
    marginTop: -1,
  },
  panelBody: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceWorkspace,
  },
  resizeHandle: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  resizeHandleGrip: {
    width: 12,
    height: 12,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  selectionRect: {
    position: "absolute",
    zIndex: 9999,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: `${String(theme.colors.accent)}20`,
    borderRadius: 6,
  },
  groupBounds: {
    position: "absolute",
    borderWidth: 2,
    borderColor: theme.colors.accent,
    borderRadius: theme.borderRadius.xl + 6,
    backgroundColor: `${String(theme.colors.accent)}15`,
    cursor: "pointer" as any,
    overflow: "visible" as any,
  },
  groupLabelRow: {
    position: "absolute",
    top: -22,
    left: 8,
    transformOrigin: "0% 100%" as any,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  groupLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.accent,
    letterSpacing: 0.3,
  },
  groupLabelInput: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
    paddingVertical: 0,
    paddingHorizontal: 2,
    minWidth: 60,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.accent,
  },
}));
