import { useState, useCallback, useEffect, useId } from "react";
import { type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import {
  createAnimatedComponent,
  useAnimatedScrollHandler,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useFileExplorerCloseGestureRef } from "@/mobile-panels/gestures";

const AnimatedScrollView = createAnimatedComponent(ScrollView);

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
  const scrollId = useId();
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const isAtLeftEdgeValue = useSharedValue(true);

  const closeGestureRef = useFileExplorerCloseGestureRef();

  // Register/unregister scroll offset tracking
  useEffect(() => {
    if (!horizontalScroll) return;
    horizontalScroll.registerScrollOffset(scrollId, 0);
    return () => {
      horizontalScroll.unregisterScrollOffset(scrollId);
    };
  }, [horizontalScroll, scrollId]);

  const recordScrollOffset = useCallback(
    (offsetX: number) => {
      if (horizontalScroll) {
        horizontalScroll.registerScrollOffset(scrollId, offsetX);
      }
    },
    [horizontalScroll, scrollId],
  );
  const recordLeftEdge = useCallback((atLeftEdge: boolean) => {
    setIsAtLeftEdge(atLeftEdge);
  }, []);

  const handleScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      const offsetX = event.contentOffset.x;
      offset.value = offsetX;
      const atLeftEdge = offsetX <= 1;
      if (atLeftEdge !== isAtLeftEdgeValue.value) {
        isAtLeftEdgeValue.value = atLeftEdge;
        scheduleOnRN(recordLeftEdge, atLeftEdge);
      }
      scheduleOnRN(recordScrollOffset, offsetX);
    },
  });

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => onScrollViewWidthChange(e.nativeEvent.layout.width),
    [onScrollViewWidthChange],
  );

  return (
    <AnimatedScrollView
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
      // When at left edge, wait for close gesture to fail before scrolling.
      // The close gesture fails quickly on leftward swipes (failOffsetX=-10),
      // so scrolling left works normally. On rightward swipes, close gesture
      // activates and closes the sidebar.
      waitFor={isAtLeftEdge && closeGestureRef?.current ? closeGestureRef : undefined}
    >
      {children}
    </AnimatedScrollView>
  );
}
