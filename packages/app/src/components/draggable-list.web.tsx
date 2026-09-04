import { memo, useCallback, useMemo, useRef, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import {
  DndContext,
  useDndContext,
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

export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const DND_MODIFIERS = [restrictToVerticalAxis];
export const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

function areRecordsEqual(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function computeDragOpacity(externalDndContext: boolean, isDragging: boolean): number {
  if (!isDragging) return 1;
  return externalDndContext ? 0.3 : 0.9;
}

function useShallowStableRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const stableRef = useRef(value);
  if (!areRecordsEqual(stableRef.current, value)) {
    stableRef.current = value;
  }
  return stableRef.current;
}

function useStableListenerRecord(
  listeners: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const latestListenersRef = useRef(listeners);
  latestListenersRef.current = listeners;
  const listenerKeys = Object.keys(listeners ?? {}).sort();
  const listenerKeySignature = listenerKeys.join("\u0000");
  const stableListenersRef = useRef<{
    keySignature: string;
    listeners: Record<string, unknown> | undefined;
  }>(undefined);
  if (stableListenersRef.current?.keySignature !== listenerKeySignature) {
    stableListenersRef.current = {
      keySignature: listenerKeySignature,
      listeners:
        listenerKeys.length === 0
          ? undefined
          : Object.fromEntries(
              listenerKeys.map((key) => [
                key,
                (...args: unknown[]) => {
                  const listener = latestListenersRef.current?.[key];
                  if (typeof listener === "function") {
                    return Reflect.apply(listener, undefined, args);
                  }
                },
              ]),
            ),
    };
  }
  return stableListenersRef.current.listeners;
}

interface SortableItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
  itemData?: Record<string, unknown>;
  externalDndContext: boolean;
}

function SortableItemInner<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
  useDragHandle,
  itemData,
  externalDndContext,
}: SortableItemProps<T>) {
  const stableItemData = useShallowStableRecord(itemData);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: stableItemData });

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
  //
  // In external-context mode the caller owns a DragOverlay that carries the
  // moving chip, so the active row itself drops its own transform and just
  // dims out — it never re-renders "in place" alongside the overlay. Every
  // other row keeps its normal sortable transform so the list still shifts
  // to make room while the drag hovers over it; freezing every row (the way
  // SortableInlineList does) would leave the list static during a same-list
  // reorder, which is the one case external mode still needs dnd-kit to
  // animate itself.
  const baseTransform =
    externalDndContext && isDragging
      ? undefined
      : CSS.Transform.toString(
          transform && isDragging ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
        );
  const scaleTransform = !externalDndContext && isDragging ? "scale(1.02)" : "";
  const combinedTransform = [baseTransform, scaleTransform].filter(Boolean).join(" ");

  const style = useMemo(
    () => ({
      transform: combinedTransform || undefined,
      transition,
      opacity: computeDragOpacity(externalDndContext, isDragging),
      zIndex: isDragging ? 1000 : 1,
    }),
    [combinedTransform, transition, isDragging, externalDndContext],
  );
  const stableAttributes = useShallowStableRecord(attributes as unknown as Record<string, unknown>);
  const stableListeners = useStableListenerRecord(
    listeners as unknown as Record<string, unknown> | undefined,
  );
  const dragHandleProps = useMemo(
    () =>
      useDragHandle
        ? {
            attributes: stableAttributes,
            listeners: stableListeners,
            setActivatorNodeRef: setActivatorNodeRef as unknown as (node: unknown) => void,
          }
        : undefined,
    [setActivatorNodeRef, stableAttributes, stableListeners, useDragHandle],
  );

  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag,
    isActive: activeId === id,
    dragHandleProps,
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

// getItemData builds a fresh object every render, so the default memo
// comparator (which Object.is-compares every prop) would never bail out for
// callers that pass it. Compare itemData by shallow value instead so memo
// still skips re-rendering rows whose drag payload didn't actually change.
function areSortableItemPropsEqual<T>(
  prev: SortableItemProps<T>,
  next: SortableItemProps<T>,
): boolean {
  return (
    prev.id === next.id &&
    prev.item === next.item &&
    prev.index === next.index &&
    prev.renderItem === next.renderItem &&
    prev.activeId === next.activeId &&
    prev.useDragHandle === next.useDragHandle &&
    prev.externalDndContext === next.externalDndContext &&
    areRecordsEqual(prev.itemData, next.itemData)
  );
}

const SortableItem = memo(SortableItemInner, areSortableItemPropsEqual) as typeof SortableItemInner;

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
  externalDndContext = false,
  getItemData,
}: DraggableListProps<T>) {
  // useDragReorderState is called unconditionally (regardless of
  // externalDndContext) to keep hook order stable across renders.
  const {
    activeId: internalActiveId,
    items: managedItems,
    handlers,
  } = useDragReorderState({
    data,
    keyExtractor,
    onDragEnd,
    onDragBegin,
  });
  const items = externalDndContext ? data : managedItems;
  // In external mode the caller's DndContext owns the drag, so the active id comes from it
  // rather than from a prop the caller would have to read from below its own provider. Only
  // read in external mode: this component renders its own DndContext *inside* its return, so in
  // internal mode the hook sees whatever unrelated context happens to sit above the list.
  const externalDnd = useDndContext();
  const externalActiveId = externalDnd.active ? String(externalDnd.active.id) : null;
  const activeId = externalDndContext ? externalActiveId : internalActiveId;
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

  const renderedItems = (
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
            itemData={getItemData?.(item, index)}
            externalDndContext={externalDndContext}
          />
        );
      })}
    </SortableContext>
  );

  const dndContent = externalDndContext ? (
    renderedItems
  ) : (
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
          {dndContent}
          {ListFooterComponent}
        </ScrollView>
      ) : (
        <>
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          {dndContent}
          {ListFooterComponent}
        </>
      )}
    </View>
  );
}
