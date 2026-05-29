import { useCallback, useMemo, type ReactElement } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  type Modifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableRenderItemInfo } from "./draggable-list.types";
import { useDragReorderState } from "./drag-reorder";

const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

const DND_MODIFIERS: Modifier[] = [restrictToHorizontalAxis];

function computeDragOpacity(hasExternalContext: boolean, isDragging: boolean): number {
  if (!isDragging) return 1;
  return hasExternalContext ? 0.3 : 0.9;
}

function SortableItem<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
  useDragHandle,
  disabled,
  itemData,
  externalDndContext,
}: {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
  disabled: boolean;
  itemData?: Record<string, unknown>;
  externalDndContext: boolean;
}): ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled, data: itemData });

  const drag = useCallback(() => {
    // dnd-kit handles drag initiation via listeners
    // This is a no-op but matches the mobile API
  }, []);

  // External DnD contexts render their own insertion affordance, so keep the
  // tab row static and let the DragOverlay carry the moving chip.
  const baseTransform = externalDndContext
    ? undefined
    : CSS.Transform.toString(
        transform && isDragging ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
      );
  const scaleTransform = !externalDndContext && isDragging ? "scale(1.01)" : "";
  const combinedTransform = [baseTransform, scaleTransform].filter(Boolean).join(" ");

  const style = useMemo(
    () => ({
      transform: combinedTransform || undefined,
      transition,
      opacity: computeDragOpacity(Boolean(externalDndContext), isDragging),
      zIndex: isDragging ? 1000 : 1,
    }),
    [combinedTransform, transition, externalDndContext, isDragging],
  );

  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag,
    isActive: activeId === id,
    dragHandleProps: useDragHandle
      ? {
          attributes: attributes as unknown as Record<string, unknown>,
          listeners: listeners as unknown as Record<string, unknown>,
          setActivatorNodeRef: setActivatorNodeRef as unknown as (node: unknown) => void,
        }
      : undefined,
  };

  const wrapperProps = useDragHandle
    ? { ref: setNodeRef }
    : { ref: setNodeRef, ...attributes, ...listeners };

  return (
    <div {...wrapperProps} style={style}>
      {renderItem(info)}
    </div>
  );
}

export function SortableInlineList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  useDragHandle = false,
  disabled = false,
  activationDistance = 8,
  onDragBegin,
  externalDndContext = false,
  activeId: externalActiveId = null,
  getItemData,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd?: (data: T[]) => void;
  useDragHandle?: boolean;
  disabled?: boolean;
  activationDistance?: number;
  onDragBegin?: () => void;
  externalDndContext?: boolean;
  activeId?: string | null;
  getItemData?: (item: T, index: number) => Record<string, unknown>;
}): ReactElement {
  const {
    activeId: internalActiveId,
    items: managedItems,
    handlers,
  } = useDragReorderState({
    data,
    keyExtractor,
    onDragEnd,
    onDragBegin,
    disabled,
  });
  const items = externalDndContext ? data : managedItems;
  const activeId = externalDndContext ? externalActiveId : internalActiveId;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: activationDistance,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(
    () => items.map((item, index) => keyExtractor(item, index)),
    [items, keyExtractor],
  );

  const renderedItems = (
    <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
      {items.map((item, index) => {
        const id = keyExtractor(item, index);
        return (
          <SortableItem
            key={id}
            id={id}
            item={item}
            index={index}
            renderItem={renderItem}
            activeId={activeId}
            useDragHandle={useDragHandle}
            disabled={disabled}
            itemData={getItemData?.(item, index)}
            externalDndContext={externalDndContext}
          />
        );
      })}
    </SortableContext>
  );

  if (externalDndContext) {
    return renderedItems;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={DND_MODIFIERS}
      onDragStart={handlers.onDragStart}
      onDragCancel={handlers.onDragCancel}
      onDragEnd={handlers.onDragEnd}
    >
      {renderedItems}
    </DndContext>
  );
}
