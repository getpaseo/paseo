import { useCallback, useState, useRef, type ReactElement } from "react";
import { View, ScrollView } from "react-native";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
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
import type {
  DraggableListProps,
  DraggableRenderItemInfo,
} from "./draggable-list.types";

export type { DraggableListProps, DraggableRenderItemInfo };

interface SortableItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
}

function SortableItem<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
}: SortableItemProps<T>) {
  const {
    attributes,
    listeners,
    setNodeRef,
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

  const baseTransform = CSS.Transform.toString(transform);
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
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
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
  contentContainerStyle,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  showsVerticalScrollIndicator = true,
  // simultaneousGestureRef is native-only, ignored on web
}: DraggableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState(data);

  // Sync items with data prop
  if (data !== items && !activeId) {
    setItems(data);
  }

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);

      if (over && active.id !== over.id) {
        const oldIndex = items.findIndex(
          (item, i) => keyExtractor(item, i) === active.id
        );
        const newIndex = items.findIndex(
          (item, i) => keyExtractor(item, i) === over.id
        );

        const newItems = arrayMove(items, oldIndex, newIndex);
        setItems(newItems);
        onDragEnd(newItems);
      }
    },
    [items, keyExtractor, onDragEnd]
  );

  const ids = items.map((item, index) => keyExtractor(item, index));

  return (
    <ScrollView
      style={style}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
    >
      {ListHeaderComponent}
      {items.length === 0 && ListEmptyComponent}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
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
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {ListFooterComponent}
    </ScrollView>
  );
}
