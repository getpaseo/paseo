import { memo, useCallback, useMemo, useRef, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type Modifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableListProps, DraggableRenderItemInfo } from "./draggable-list.types";
import { getDragActivationConstraints, useDragReorderState } from "./drag-reorder";

export type { DraggableListProps, DraggableRenderItemInfo };

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const DND_MODIFIERS = [restrictToVerticalAxis];
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

interface SortableItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
}

function SortableItemInner<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
  useDragHandle,
}: SortableItemProps<T>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const dragRef = useRef<(() => void) | null>(null);

  const drag = useCallback(() => {
    // dnd-kit handles drag initiation via listeners
    // This is a no-op but matches the mobile API
  }, []);

  // Store listeners in ref so drag handle can access them
  dragRef.current = () => {
    // Trigger drag - handled by dnd-kit's listeners
  };

  // dnd-kit can set `scaleX/scaleY` on the active item when dragging over a
  // differently-sized droppable. For variable-height rows this can look like
  // the "ghost" stretches. Keep the dragged item's size stable by zeroing
  // out the dnd-kit scaling component.
  const baseTransform = CSS.Transform.toString(
    transform && isDragging ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
  );
  const scaleTransform = isDragging ? "scale(1.02)" : "";
  const combinedTransform = [baseTransform, scaleTransform].filter(Boolean).join(" ");

  const style = useMemo(
    () => ({
      transform: combinedTransform || undefined,
      transition,
      opacity: isDragging ? 0.9 : 1,
      zIndex: isDragging ? 1000 : 1,
    }),
    [combinedTransform, transition, isDragging],
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

const SortableItem = memo(SortableItemInner) as typeof SortableItemInner;

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  style,
  containerStyle,
  contentContainerStyle,
  testID,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  showsVerticalScrollIndicator = true,
  scrollEnabled = true,
  extraData: _extraData,
  useDragHandle = false,
  // simultaneousGestureRef is native-only, ignored on web
  onDragBegin,
  nestable: _nestable = false,
}: DraggableListProps<T>) {
  const { activeId, items, handlers } = useDragReorderState({
    data,
    keyExtractor,
    onDragEnd,
    onDragBegin,
  });
  const activationConstraints = getDragActivationConstraints(useDragHandle, DRAG_ACTIVATION_CONFIG);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: activationConstraints.mouse,
    }),
    useSensor(TouchSensor, {
      activationConstraint: activationConstraints.touch,
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(
    () => items.map((item, index) => keyExtractor(item, index)),
    [items, keyExtractor],
  );
  const wrapperStyle = useMemo(
    () => [
      { position: "relative" as const },
      scrollEnabled ? { flex: 1, minHeight: 0 } : null,
      containerStyle,
    ],
    [scrollEnabled, containerStyle],
  );

  return (
    <View style={wrapperStyle}>
      {scrollEnabled ? (
        <ScrollView
          testID={testID}
          style={style}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        >
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={DND_MODIFIERS}
            onDragStart={handlers.onDragStart}
            onDragCancel={handlers.onDragCancel}
            onDragEnd={handlers.onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
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
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {ListFooterComponent}
        </ScrollView>
      ) : (
        <>
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={DND_MODIFIERS}
            onDragStart={handlers.onDragStart}
            onDragCancel={handlers.onDragCancel}
            onDragEnd={handlers.onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
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
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {ListFooterComponent}
        </>
      )}
    </View>
  );
}
