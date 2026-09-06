import { RefreshControl } from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DraggableFlatList, {
  NestableDraggableFlatList,
  type RenderItemParams,
} from "react-native-draggable-flatlist";
import { useUnistyles } from "react-native-unistyles";
import type { DraggableListProps, DraggableRenderItemInfo } from "./draggable-list.types";
import {
  createDragReleaseRecovery,
  type DragReleaseRecovery,
} from "./drag-reorder/drag-release-recovery";

export type { DraggableListProps, DraggableRenderItemInfo };

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
  // The dependency commits a drop only after its spring finishes. If that callback is lost,
  // remounting clears the native gesture and releases the nestable outer-scroll lock.
  const [isDragging, setIsDragging] = useState(false);
  const [dragHostRevision, setDragHostRevision] = useState(0);
  const dragReleaseRecoveryRef = useRef<DragReleaseRecovery | null>(null);
  if (dragReleaseRecoveryRef.current === null) {
    dragReleaseRecoveryRef.current = createDragReleaseRecovery(() => {
      setIsDragging(false);
      setDragHostRevision((revision) => revision + 1);
    });
  }
  const dragReleaseRecovery = dragReleaseRecoveryRef.current;

  useEffect(() => () => dragReleaseRecovery.dispose(), [dragReleaseRecovery]);

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
      return renderItem(info);
    },
    [renderItem],
  );

  const handleDragEnd = useCallback(
    ({ data: newData }: { data: T[] }) => {
      dragReleaseRecovery.dragFinished();
      setIsDragging(false);
      onDragEnd(newData);
    },
    [dragReleaseRecovery, onDragEnd],
  );

  const handleDragBegin = useCallback(() => {
    dragReleaseRecovery.dragBegan();
    setIsDragging(true);
    onDragBeginProp?.();
  }, [dragReleaseRecovery, onDragBeginProp]);

  const handleRelease = useCallback(() => {
    setIsDragging(false);
    dragReleaseRecovery.fingerReleased();
  }, [dragReleaseRecovery]);

  const handleDragTerminate = useCallback(() => {
    dragReleaseRecovery.dragFinished();
    setIsDragging(false);
  }, [dragReleaseRecovery]);

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
      key={dragHostRevision}
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
      // Higher activation distance reduces accidental drag capture while nested
      // lists are inside a scroll container.
      activationDistance={20}
      onDragBegin={handleDragBegin}
      onRelease={handleRelease}
      onDragTerminate={handleDragTerminate}
      // @ts-ignore - waitFor is supported by RNGH FlatList but missing from DraggableFlatList types
      waitFor={waitFor}
      refreshControl={refreshControl}
    />
  );
}
