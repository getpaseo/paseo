import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { getDragActivationConstraints } from "@/components/drag-reorder";
import { DRAG_ACTIVATION_CONFIG, restrictToVerticalAxis } from "@/components/draggable-list.web";
import type { SidebarProjectGroup } from "@/components/sidebar/sidebar-projection";
import {
  parseProjectDropData,
  resolveProjectDrop,
  type ProjectDropData,
} from "@/components/sidebar/project-drop-resolution";
import type {
  ProjectDragActive,
  ProjectDragContextProps,
  ProjectDropPreview,
  ProjectGroupSortable,
} from "./project-drag-context";

export type {
  ProjectDragActive,
  ProjectDragContextProps,
  ProjectDropInput,
  ProjectDropPreview,
  ProjectGroupDragHandle,
  ProjectGroupReorderInput,
  ProjectGroupSortable,
} from "./project-drag-context";

/**
 * One dnd-kit context over every project list in the sidebar, so a project row can leave the
 * list it was rendered in: onto another group's rows or header, out to the ungrouped rows, or
 * onto the two drop zones that only exist while a drag is in flight. The same context sorts the
 * group sections themselves: a header's press-and-drag moves its whole group past the others.
 *
 * Same shape as the tab-and-pane drag in split-container.tsx: every droppable carries a
 * `kind`, collision detection asks "what is the pointer inside" by kind before it falls back
 * to the nearest row, and the moving chip is a DragOverlay. The overlay is portalled to the
 * document body because a transformed ancestor (the compact sidebar slides in with translateX)
 * would otherwise become its containing block and offset it.
 *
 * Two contexts rather than one: the active drag changes twice per drag, the preview changes on
 * every row the pointer crosses, and only the indicator on that row should render for it.
 */
const ProjectDragActiveContext = createContext<ProjectDragActive | null>(null);
const ProjectDropPreviewContext = createContext<ProjectDropPreview | null>(null);

const DROP_ZONE_ID_PREFIX = "project-drop-zone:";
const GROUP_HEADER_ID_PREFIX = "project-group-header:";
const GROUP_SECTION_ID_PREFIX = "project-group-section:";
const KIND_PRIORITY: readonly ProjectDropData["kind"][] = [
  "project-drop-zone",
  "project-group-header",
  "project-row",
];

function kindOf(entry: { data?: { droppableContainer?: { data: { current?: unknown } } } }) {
  return parseProjectDropData(entry.data?.droppableContainer?.data.current)?.kind ?? null;
}

function containersOfKind(args: Parameters<CollisionDetection>[0], kind: ProjectDropData["kind"]) {
  return args.droppableContainers.filter(
    (container) => parseProjectDropData(container.data.current)?.kind === kind,
  );
}

// A group drag only ever lands on another group section. For a row, inside a zone or a header
// beats a row under the same pointer; when the pointer is in dead space the nearest *row* wins,
// never a zone, or the gap between two rows would snap to the zones parked at the bottom of the
// column.
const projectCollisionDetection: CollisionDetection = (args) => {
  if (parseProjectDropData(args.active.data.current)?.kind === "project-group") {
    return closestCenter({ ...args, droppableContainers: containersOfKind(args, "project-group") });
  }
  const pointerHits = pointerWithin(args);
  for (const kind of KIND_PRIORITY) {
    const hits = pointerHits.filter((entry) => kindOf(entry) === kind);
    if (hits.length > 0) return hits;
  }
  return closestCenter({ ...args, droppableContainers: containersOfKind(args, "project-row") });
};

function placementFor(
  event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">,
): "before" | "after" | null {
  const translated = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!translated || !overRect || overRect.height <= 0) return null;
  const activeMiddle = translated.top + translated.height / 2;
  const overMiddle = overRect.top + overRect.height / 2;
  return activeMiddle < overMiddle ? "before" : "after";
}

export function ProjectDragContext({
  children,
  onDrop,
  onGroupReorder,
  renderOverlay,
}: ProjectDragContextProps): ReactElement {
  const [active, setActive] = useState<ProjectDragActive | null>(null);
  const [preview, setPreview] = useState<ProjectDropPreview | null>(null);
  const activation = getDragActivationConstraints(true, DRAG_ACTIVATION_CONFIG);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: activation.mouse }),
    useSensor(TouchSensor, { activationConstraint: activation.touch }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = parseProjectDropData(event.active.data.current);
    if (data?.kind === "project-row") {
      setActive({ kind: "row", viewKey: data.viewKey, groupKey: data.groupKey });
    } else if (data?.kind === "project-group") {
      setActive({ kind: "group", groupKey: data.groupKey });
    } else {
      setActive(null);
    }
    setPreview(null);
  }, []);

  // The insertion line is only for a row in another list: rows in the dragged row's own list
  // already move aside through the sortable transform.
  const updatePreview = useCallback((event: DragMoveEvent | DragOverEvent) => {
    const activeData = parseProjectDropData(event.active.data.current);
    const overData = parseProjectDropData(event.over?.data.current);
    if (
      activeData?.kind !== "project-row" ||
      overData?.kind !== "project-row" ||
      overData.viewKey === activeData.viewKey ||
      overData.groupKey === activeData.groupKey
    ) {
      setPreview(null);
      return;
    }
    const placement = placementFor(event);
    setPreview(placement ? { anchorViewKey: overData.viewKey, placement } : null);
  }, []);

  const clear = useCallback(() => {
    setActive(null);
    setPreview(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = parseProjectDropData(event.active.data.current);
      clear();
      if (activeData?.kind === "project-group") {
        const overData = parseProjectDropData(event.over?.data.current);
        if (overData?.kind === "project-group" && overData.groupKey !== activeData.groupKey) {
          onGroupReorder({ activeGroupKey: activeData.groupKey, overGroupKey: overData.groupKey });
        }
        return;
      }
      if (activeData?.kind !== "project-row") return;
      const over = event.over ? { id: String(event.over.id), data: event.over.data.current } : null;
      const resolution = resolveProjectDrop({
        activeViewKey: activeData.viewKey,
        activeGroupKey: activeData.groupKey,
        over,
        placement: placementFor(event) ?? "after",
      });
      onDrop({ activeViewKey: activeData.viewKey, resolution });
    },
    [clear, onDrop, onGroupReorder],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={projectCollisionDetection}
      modifiers={DRAG_MODIFIERS}
      onDragStart={handleDragStart}
      onDragMove={updatePreview}
      onDragOver={updatePreview}
      onDragCancel={clear}
      onDragEnd={handleDragEnd}
    >
      <ProjectDragActiveContext.Provider value={active}>
        <ProjectDropPreviewContext.Provider value={preview}>
          {children}
        </ProjectDropPreviewContext.Provider>
      </ProjectDragActiveContext.Provider>
      {createPortal(
        <DragOverlay dropAnimation={null}>{active ? renderOverlay(active) : null}</DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

const DRAG_MODIFIERS = [restrictToVerticalAxis];

export function useProjectDragActive(): ProjectDragActive | null {
  return useContext(ProjectDragActiveContext);
}

/** A group header takes drops for its whole group, which is the only way into a collapsed one. */
export function useProjectGroupHeaderDroppable(group: SidebarProjectGroup): {
  setNodeRef: Ref<View> | undefined;
  isOver: boolean;
} {
  const active = useProjectDragActive();
  const firstViewKey = group.projects[0]?.viewKey ?? "";
  const data = useMemo<ProjectDropData>(
    () => ({
      kind: "project-group-header",
      groupKey: group.key,
      groupName: group.name,
      firstViewKey,
    }),
    [firstViewKey, group.key, group.name],
  );
  // The dragged row's own header stays enabled on purpose: a disabled droppable falls out of
  // collision detection, and the nearest enabled target is then one of the group's rows, which
  // would reorder the row instead of doing nothing.
  const { setNodeRef, isOver } = useDroppable({
    id: `${GROUP_HEADER_ID_PREFIX}${group.key}`,
    disabled: active?.kind !== "row",
    data,
  });
  const isDropTarget = isOver && active?.kind === "row" && active.groupKey !== group.key;
  return { setNodeRef: setNodeRef as unknown as Ref<View>, isOver: isDropTarget };
}

/** The sortable list the group sections live in. Ids are prefixed so they never meet a view key. */
export function ProjectGroupSortableContext({
  groupKeys,
  children,
}: {
  groupKeys: readonly string[];
  children: ReactNode;
}): ReactElement {
  const items = useMemo(
    () => groupKeys.map((key) => `${GROUP_SECTION_ID_PREFIX}${key}`),
    [groupKeys],
  );
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

const SECTION_TRANSITION = {
  transitionProperty: "transform",
  transitionDuration: "200ms",
  transitionTimingFunction: "ease",
} as const;

/**
 * A whole group section as one sortable: the section is the node (so the others shift by its
 * full height), the header toggle is the activator. The section itself only dims while it
 * moves; the header chip in the DragOverlay is what follows the pointer.
 */
export function useProjectGroupSortable(group: SidebarProjectGroup): ProjectGroupSortable {
  const data = useMemo<ProjectDropData>(
    () => ({ kind: "project-group", groupKey: group.key }),
    [group.key],
  );
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: `${GROUP_SECTION_ID_PREFIX}${group.key}`, data });
  // Space and Enter on the toggle keep toggling; a group drag starts from the pointer only.
  const pointerListeners = useMemo(
    () =>
      Object.fromEntries(Object.entries(listeners ?? {}).filter(([name]) => name !== "onKeyDown")),
    [listeners],
  );
  const translateY = transform && !isDragging ? transform.y : null;
  const style = useMemo<StyleProp<ViewStyle>>(
    () => ({
      transform: translateY === null ? undefined : [{ translateY }],
      ...(transition ? SECTION_TRANSITION : null),
      opacity: isDragging ? 0.3 : 1,
    }),
    [isDragging, transition, translateY],
  );
  const dragHandle = useMemo(
    () => ({
      setActivatorNodeRef: setActivatorNodeRef as unknown as Ref<View>,
      listeners: pointerListeners,
    }),
    [pointerListeners, setActivatorNodeRef],
  );
  return { setNodeRef: setNodeRef as unknown as Ref<View>, style, dragHandle };
}

/**
 * The targets a row can only reach while it is being dragged: a new group, and, for a grouped
 * row, the way out. They sit under the ungrouped rows so nothing above moves when they appear.
 */
export function ProjectDropZones(): ReactElement | null {
  const active = useProjectDragActive();
  const { t } = useTranslation();
  if (active?.kind !== "row") return null;
  return (
    <View style={styles.zones} testID="sidebar-project-drop-zones">
      <ProjectDropZone
        zone="new-group"
        label={t("sidebar.project.group.dropNewGroup")}
        testID="sidebar-project-drop-new-group"
      />
      {active.groupKey !== null ? (
        <ProjectDropZone
          zone="ungroup"
          label={t("sidebar.project.group.removeFromGroup")}
          testID="sidebar-project-drop-ungroup"
        />
      ) : null}
    </View>
  );
}

function ProjectDropZone({
  zone,
  label,
  testID,
}: {
  zone: "new-group" | "ungroup";
  label: string;
  testID: string;
}): ReactElement {
  const data = useMemo<ProjectDropData>(() => ({ kind: "project-drop-zone", zone }), [zone]);
  const { setNodeRef, isOver } = useDroppable({ id: `${DROP_ZONE_ID_PREFIX}${zone}`, data });
  return (
    <View
      ref={setNodeRef as unknown as Ref<View>}
      style={[styles.zone, isOver && styles.zoneOver]}
      testID={testID}
    >
      <Text style={[styles.zoneLabel, isOver && styles.zoneLabelOver]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The line that says where a row from another list will land. Renders only on that row. */
export function ProjectRowDropIndicator({ viewKey }: { viewKey: string }): ReactElement | null {
  const preview = useContext(ProjectDropPreviewContext);
  if (!preview || preview.anchorViewKey !== viewKey) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.indicator,
        preview.placement === "before" ? styles.indicatorBefore : styles.indicatorAfter,
      ]}
      testID={`sidebar-project-drop-indicator-${viewKey}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  zones: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  // A project row's geometry, drawn as an outline: it is a place a row can go, not a row.
  zone: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  zoneOver: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  zoneLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  zoneLabelOver: {
    color: theme.colors.foreground,
  },
  indicator: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 2,
  },
  // Centered on the row gap so the line reads as between rows, not as a row's edge.
  indicatorBefore: {
    top: -3,
  },
  indicatorAfter: {
    bottom: -1,
  },
}));
