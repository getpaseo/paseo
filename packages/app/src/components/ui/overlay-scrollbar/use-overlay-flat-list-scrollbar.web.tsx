import { useCallback, useState, type RefObject } from "react";
import {
  FlatList,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { OverlayScrollbar, type OverlayScrollbarMetrics } from "./overlay-scrollbar";
import type { OverlayFlatListScrollbar } from "./use-overlay-flat-list-scrollbar";

export function useOverlayFlatListScrollbar<ItemT>(
  listRef: RefObject<FlatList<ItemT> | null>,
  options: { enabled: boolean },
): OverlayFlatListScrollbar {
  const [metrics, setMetrics] = useState<OverlayScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setMetrics((previous) => ({
      ...previous,
      offset: Math.max(0, event.nativeEvent.contentOffset.y),
      viewportSize: Math.max(0, event.nativeEvent.layoutMeasurement.height),
      contentSize: Math.max(0, event.nativeEvent.contentSize.height),
    }));
  }, []);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setMetrics((previous) => ({
      ...previous,
      viewportSize: Math.max(0, event.nativeEvent.layout.height),
    }));
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    setMetrics((previous) => ({ ...previous, contentSize: Math.max(0, height) }));
  }, []);
  const scrollToOffset = useCallback(
    (offset: number) => listRef.current?.scrollToOffset({ offset, animated: false }),
    [listRef],
  );

  return {
    enabled: options.enabled,
    onContentSizeChange,
    onLayout,
    onScroll,
    overlay: options.enabled ? (
      <OverlayScrollbar metrics={metrics} onScrollToOffset={scrollToOffset} />
    ) : null,
  };
}
