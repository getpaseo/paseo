import { useCallback, useRef, useState, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  type Modifier,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableListProps, DraggableRenderItemInfo } from "./draggable-list.types";
import { useWebScrollViewScrollbar } from "./use-web-scrollbar";

export type { DraggableListProps, DraggableRenderItemInfo };

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

interface SortableItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
}

function SortableItem<T>({
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

  const style = {
    transform: combinedTransform || undefined,
    transition,
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 1000 : 1,
  };

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
  enableDesktopWebScrollbar = false,
  scrollEnabled = true,
  useDragHandle = false,
  // simultaneousGestureRef is native-only, ignored on web
  onDragBegin,
  nestable: _nestable = false,
}: DraggableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragItems, setDragItems] = useState<T[] | null>(null);
  const items = dragItems ?? data;
  const showCustomScrollbar = enableDesktopWebScrollbar && scrollEnabled;
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollbar = useWebScrollViewScrollbar(scrollViewRef, {
    enabled: showCustomScrollbar,
  });

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

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDragItems(data);
      setActiveId(String(event.active.id));
      onDragBegin?.();
    },
    [data, onDragBegin],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);
      setDragItems(null);

      if (over && active.id !== over.id) {
        const oldIndex = items.findIndex((item, i) => keyExtractor(item, i) === active.id);
        const newIndex = items.findIndex((item, i) => keyExtractor(item, i) === over.id);

        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
          const newItems = arrayMove(items, oldIndex, newIndex);
          onDragEnd(newItems);
        }
      }
    },
    [items, keyExtractor, onDragEnd],
  );

  const ids = items.map((item, index) => keyExtractor(item, index));
  const wrapperStyle = [
    { position: "relative" as const },
    scrollEnabled ? { flex: 1, minHeight: 0 } : null,
    containerStyle,
  ];

  return (
    <View style={wrapperStyle}>
      {scrollEnabled ? (
        <ScrollView
          ref={scrollViewRef}
          testID={testID}
          style={style}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={showCustomScrollbar ? false : showsVerticalScrollIndicator}
          onLayout={scrollbar.onLayout}
          onContentSizeChange={scrollbar.onContentSizeChange}
          onScroll={scrollbar.onScroll}
          scrollEventThrottle={16}
        >
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
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
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
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
      {scrollbar.overlay}
    </View>
  );
}
