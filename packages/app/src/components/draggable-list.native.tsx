import { RefreshControl } from "react-native";
import { useCallback, useState } from "react";
import DraggableFlatList, {
  type RenderItemParams,
} from "react-native-draggable-flatlist";
import { useUnistyles } from "react-native-unistyles";
import type {
  DraggableListProps,
  DraggableRenderItemInfo,
} from "./draggable-list.types";

export type { DraggableListProps, DraggableRenderItemInfo };

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  style,
  contentContainerStyle,
  testID,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  showsVerticalScrollIndicator = true,
  enableDesktopWebScrollbar: _enableDesktopWebScrollbar = false,
  refreshing,
  onRefresh,
  simultaneousGestureRef,
  waitFor,
}: DraggableListProps<T>) {
  const { theme } = useUnistyles();
  const [isDragging, setIsDragging] = useState(false);

  // Pass the ref directly to DraggableFlatList - it handles the gesture coordination
  // The ref may not have .current set yet, but that's okay - DraggableFlatList will
  // read it when the gesture is being recognized
  const simultaneousHandlers = simultaneousGestureRef ? [simultaneousGestureRef] : undefined;

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
    [renderItem]
  );

  const handleDragEnd = useCallback(
    ({ data: newData }: { data: T[] }) => {
      setIsDragging(false);
      onDragEnd(newData);
    },
    [onDragEnd]
  );

  const handleDragBegin = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleRelease = useCallback(() => {
    setIsDragging(false);
  }, []);

  const showRefreshControl = Boolean(onRefresh) && (!isDragging || Boolean(refreshing));

  return (
    <DraggableFlatList
      testID={testID}
      data={data}
      keyExtractor={keyExtractor}
      renderItem={handleRenderItem}
      onDragEnd={handleDragEnd}
      style={style}
      containerStyle={{ flex: 1 }}
      contentContainerStyle={contentContainerStyle}
      ListFooterComponent={ListFooterComponent}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      simultaneousHandlers={simultaneousHandlers}
      // Higher activationDistance prevents drag from interfering with nested onLongPress handlers
      activationDistance={20}
      onDragBegin={handleDragBegin}
      onRelease={handleRelease}
      // @ts-expect-error - waitFor is supported by RNGH FlatList but not typed in DraggableFlatList
      waitFor={waitFor}
      refreshControl={
        showRefreshControl ? (
          <RefreshControl
            refreshing={refreshing ?? false}
            onRefresh={onRefresh}
            tintColor={theme.colors.foregroundMuted}
            colors={[theme.colors.foregroundMuted]}
          />
        ) : undefined
      }
    />
  );
}
