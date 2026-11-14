import { createContext, useCallback, useContext, useState, type ReactElement } from "react";
import { View } from "react-native";
import { ScrollView as GestureScrollView } from "react-native-gesture-handler";
import {
  createAnimatedComponent,
  useAnimatedReaction,
  useAnimatedRef,
  type AnimatedRef,
} from "react-native-reanimated";
import Sortable, {
  useItemContext,
  type SortableGridDragEndParams,
  type SortableGridRenderItem,
} from "react-native-sortables";
import { scheduleOnRN } from "react-native-worklets";
import type {
  DraggableListDragHandleProps,
  DraggableListHandleProps,
  DraggableListProps,
  DraggableListScrollViewProps,
  DraggableRenderItemInfo,
} from "./draggable-list.types";

export type { DraggableListProps, DraggableRenderItemInfo };

// Sortables places every row with UI-thread offsets, so the reorder commit never moves a row by
// itself. Lists that position rows by React child order plus a held drag translate paint one
// frame of new order + old translate when the reorder commits.
//
// Render lists inside `DraggableListScrollView` so a dragged row autoscrolls it.
//
// A drag interrupted by the system (app backgrounded, incoming call) commits the order it
// previewed: sortables ends a cancelled drag through the same `onDragEnd` as a release.

// A row lifts after a still hold. Moving first fails the drag, so the touch scrolls the list or
// swipes the panel instead.
const DRAG_ACTIVATION_DELAY_MS = 180;
const DRAG_ACTIVATION_FAIL_OFFSET_PX = 4;

// Native handles carry no props; their presence marks the row as the handle.
const NATIVE_DRAG_HANDLE_PROPS: DraggableListDragHandleProps = {};

const AnimatedGestureScrollView = createAnimatedComponent(GestureScrollView);

const ScrollViewRefContext = createContext<AnimatedRef | null>(null);

export function DraggableListScrollView({
  children,
  simultaneousGestureRef,
  ...scrollViewProps
}: DraggableListScrollViewProps) {
  const scrollViewRef = useAnimatedRef();
  return (
    <AnimatedGestureScrollView
      {...scrollViewProps}
      ref={scrollViewRef}
      simultaneousHandlers={simultaneousGestureRef}
    >
      <ScrollViewRefContext.Provider value={scrollViewRef}>
        {children}
      </ScrollViewRefContext.Provider>
    </AnimatedGestureScrollView>
  );
}

export function DraggableListHandle({ children, dragHandleProps }: DraggableListHandleProps) {
  if (!dragHandleProps) {
    return children;
  }
  return <Sortable.Handle>{children}</Sortable.Handle>;
}

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  containerStyle,
  testID,
  useDragHandle = false,
}: DraggableListProps<T>) {
  const scrollViewRef = useContext(ScrollViewRefContext);
  const dragHandleProps = useDragHandle ? NATIVE_DRAG_HANDLE_PROPS : undefined;

  const renderGridItem = useCallback<SortableGridRenderItem<T>>(
    ({ item, index }) => (
      <DraggableListItem
        item={item}
        index={index}
        renderItem={renderItem}
        dragHandleProps={dragHandleProps}
      />
    ),
    [dragHandleProps, renderItem],
  );

  const handleDragEnd = useCallback(
    ({ data: reorderedData }: SortableGridDragEndParams<T>) => {
      onDragEnd(reorderedData);
    },
    [onDragEnd],
  );

  return (
    <View testID={testID} style={containerStyle}>
      <Sortable.Grid
        columns={1}
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderGridItem}
        onDragEnd={handleDragEnd}
        customHandle={useDragHandle}
        dragActivationDelay={DRAG_ACTIVATION_DELAY_MS}
        dragActivationFailOffset={DRAG_ACTIVATION_FAIL_OFFSET_PX}
        scrollableRef={scrollViewRef ?? undefined}
        autoScrollEnabled={scrollViewRef !== null}
        // Clamped to the single column's width, so a dragged row moves only vertically.
        overDrag="vertical"
        // Rows style themselves from `isActive`; the other rows stay as they are.
        activeItemScale={1}
        activeItemShadowOpacity={0}
        inactiveItemOpacity={1}
        inactiveItemScale={1}
        hapticsEnabled
      />
    </View>
  );
}

function DraggableListItem<T>({
  item,
  index,
  renderItem,
  dragHandleProps,
}: {
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { isActive } = useItemContext();
  const [active, setActive] = useState(false);
  useAnimatedReaction(
    () => isActive.value,
    (next, previous) => {
      if (previous !== null && next !== previous) {
        scheduleOnRN(setActive, next);
      }
    },
  );
  return renderItem({ item, index, isActive: active, dragHandleProps });
}
