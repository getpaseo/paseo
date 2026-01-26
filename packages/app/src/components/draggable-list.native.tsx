import { RefreshControl } from "react-native";
import { useCallback } from "react";
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
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  showsVerticalScrollIndicator = true,
  refreshing,
  onRefresh,
  simultaneousGestureRef,
  waitFor,
}: DraggableListProps<T>) {
  const { theme } = useUnistyles();

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
      onDragEnd(newData);
    },
    [onDragEnd]
  );

  return (
    <DraggableFlatList
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
      // @ts-expect-error - waitFor is supported by RNGH FlatList but not typed in DraggableFlatList
      waitFor={waitFor}
      refreshControl={
        onRefresh ? (
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
