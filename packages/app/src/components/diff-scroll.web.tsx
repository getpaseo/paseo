import { useCallback, useId, useLayoutEffect, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useFileExplorerCloseGestureRef } from "@/mobile-panels/gestures";

interface DiffScrollProps {
  children: React.ReactNode;
  onScrollViewWidthChange: (width: number) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  offset: SharedValue<number>;
  testID?: string;
}

export function DiffScroll({
  children,
  onScrollViewWidthChange,
  style,
  contentContainerStyle,
  offset,
  testID,
}: DiffScrollProps) {
  const horizontalScroll = useHorizontalScrollOptional();
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const scrollId = useId();
  const closeGestureRef = useFileExplorerCloseGestureRef();

  useLayoutEffect(() => {
    horizontalScroll?.registerScrollOffset(scrollId, 0);
    return () => horizontalScroll?.unregisterScrollOffset(scrollId);
  }, [horizontalScroll, scrollId]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      offset.value = offsetX;
      setIsAtLeftEdge(offsetX <= 1);
      horizontalScroll?.registerScrollOffset(scrollId, offsetX);
    },
    [horizontalScroll, offset, scrollId],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onScrollViewWidthChange(event.nativeEvent.layout.width),
    [onScrollViewWidthChange],
  );

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      bounces={false}
      style={style}
      contentContainerStyle={contentContainerStyle}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onLayout={handleLayout}
      testID={testID}
      waitFor={isAtLeftEdge && closeGestureRef?.current ? closeGestureRef : undefined}
    >
      {children}
    </ScrollView>
  );
}
