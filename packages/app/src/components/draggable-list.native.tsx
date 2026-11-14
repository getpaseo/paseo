import { RefreshControl, View, type GestureResponderEvent } from "react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Haptics from "expo-haptics";
import DraggableFlatList, {
  NestableDraggableFlatList,
  type RenderItemParams,
} from "react-native-draggable-flatlist";
import type { GestureType } from "react-native-gesture-handler";
import { useUnistyles } from "react-native-unistyles";
import { useContentDrag } from "@/components/ui/scroll-view";
import { createDragHold } from "./drag-reorder/drag-hold";
import { movedItemKey } from "./drag-reorder/native-drop";
import type {
  DraggableListHandleProps,
  DraggableListProps,
  DraggableRenderItemInfo,
} from "./draggable-list.types";

export type { DraggableListHandleProps, DraggableListProps, DraggableRenderItemInfo };

/** The row's `drag()`, for its handle. */
const RowDragContext = createContext<(() => void) | null>(null);

// The list only accepts drag() once its pan gesture has begun for this touch, and that begin
// reaches JS after the touch does. Same hold and slop as the sidebar rows' drag arm.
const HANDLE_HOLD_MS = 180;
const HANDLE_HOLD_SLOP_PX = 4;

function touchPoint(event: GestureResponderEvent) {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
}

/**
 * On native the handle has no accessibility role or label: a screen reader cannot hold and drag,
 * and announcing a control whose activation does nothing misleads. The label is for web, where
 * the keyboard reorders through it.
 */
export function DraggableListHandle({ testID, style, children }: DraggableListHandleProps) {
  const drag = useContext(RowDragContext);
  const hold = useMemo(
    () =>
      drag
        ? createDragHold({
            delayMs: HANDLE_HOLD_MS,
            slopPx: HANDLE_HOLD_SLOP_PX,
            onArm: () => {
              void Haptics.selectionAsync().catch(() => {});
              drag();
            },
          })
        : null,
    [drag],
  );
  useEffect(() => () => hold?.cancel(), [hold]);
  const startHold = useCallback(
    (event: GestureResponderEvent) => hold?.begin(touchPoint(event)),
    [hold],
  );
  const moveHold = useCallback(
    (event: GestureResponderEvent) => hold?.move(touchPoint(event)),
    [hold],
  );
  const cancelHold = useCallback(() => hold?.cancel(), [hold]);
  return (
    <View
      onTouchStart={startHold}
      onTouchMove={moveHold}
      onTouchEnd={cancelHold}
      onTouchCancel={cancelHold}
      style={style}
      testID={testID}
    >
      {children}
    </View>
  );
}

const SCROLL_ENABLED_FLEX_STYLE = { flex: 1 };

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
  useDragHandle: _useDragHandle = false,
  refreshing,
  onRefresh,
  extraData,
  simultaneousGestureRef,
  gestureHostPresented,
  waitFor,
  onDragBegin: onDragBeginProp,
  nestable = false,
}: DraggableListProps<T>) {
  const { theme } = useUnistyles();
  const [isDragging, setIsDragging] = useState(false);
  // Inside a sheet the sheet would otherwise take the vertical move from an armed row.
  const contentDrag = useContentDrag();
  const { attach: attachContentDrag } = contentDrag;
  const dragGestureRef = useRef<GestureType | undefined>(undefined);
  // Passive effects run after the list's gesture detector has attached and filled the ref.
  useEffect(() => attachContentDrag?.(dragGestureRef), [attachContentDrag]);

  // Pass the ref directly to DraggableFlatList - it handles gesture
  // coordination internally for nestable lists.
  const simultaneousHandlers = useMemo(
    () => (simultaneousGestureRef ? [simultaneousGestureRef] : undefined),
    [simultaneousGestureRef],
  );

  const refreshColors = useMemo(
    () => [theme.colors.foregroundMuted],
    [theme.colors.foregroundMuted],
  );

  const handleRenderItem = useCallback(
    ({ item, drag, isActive, getIndex }: RenderItemParams<T>) => {
      const index = getIndex() ?? 0;
      const info: DraggableRenderItemInfo<T> = {
        item,
        index,
        drag,
        isActive,
      };
      return <RowDragContext.Provider value={drag}>{renderItem(info)}</RowDragContext.Provider>;
    },
    [renderItem],
  );

  const handleDragEnd = useCallback(
    (drop: { data: T[]; from: number; to: number }) => {
      setIsDragging(false);
      contentDrag.setActive(false);
      const moved = movedItemKey(drop, keyExtractor);
      if (moved !== null) onDragEnd(drop.data, moved);
    },
    [contentDrag, keyExtractor, onDragEnd],
  );

  const handleDragBegin = useCallback(() => {
    setIsDragging(true);
    contentDrag.setActive(true);
    onDragBeginProp?.();
  }, [contentDrag, onDragBeginProp]);

  const handleRelease = useCallback(() => {
    setIsDragging(false);
    contentDrag.setActive(false);
  }, [contentDrag]);

  const showRefreshControl = Boolean(onRefresh) && (!isDragging || Boolean(refreshing));
  const resolvedContainerStyle =
    containerStyle ?? (scrollEnabled ? SCROLL_ENABLED_FLEX_STYLE : undefined);
  const shouldShowRefreshControl = showRefreshControl && !nestable;
  const ListComponent: typeof DraggableFlatList = (
    nestable ? (NestableDraggableFlatList as unknown) : DraggableFlatList
  ) as typeof DraggableFlatList;

  const refreshControl = useMemo(
    () =>
      shouldShowRefreshControl ? (
        <RefreshControl
          refreshing={refreshing ?? false}
          onRefresh={onRefresh}
          tintColor={theme.colors.foregroundMuted}
          colors={refreshColors}
        />
      ) : undefined,
    [shouldShowRefreshControl, refreshing, onRefresh, theme.colors.foregroundMuted, refreshColors],
  );

  return (
    <ListComponent
      testID={testID}
      data={data}
      keyExtractor={keyExtractor}
      renderItem={handleRenderItem}
      onDragEnd={handleDragEnd}
      style={style}
      containerStyle={resolvedContainerStyle}
      contentContainerStyle={contentContainerStyle}
      ListFooterComponent={ListFooterComponent}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      scrollEnabled={scrollEnabled}
      extraData={extraData}
      simultaneousHandlers={simultaneousHandlers}
      dragGestureHostPresented={gestureHostPresented}
      dragGestureRef={attachContentDrag ? dragGestureRef : undefined}
      // Higher activation distance reduces accidental drag capture while nested
      // lists are inside a scroll container.
      activationDistance={20}
      onDragBegin={handleDragBegin}
      onRelease={handleRelease}
      // @ts-ignore - waitFor is supported by RNGH FlatList but missing from DraggableFlatList types
      waitFor={waitFor}
      refreshControl={refreshControl}
    />
  );
}
