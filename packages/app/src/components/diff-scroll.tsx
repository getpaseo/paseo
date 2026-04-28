import { useState, useCallback, useEffect, useId, useRef } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";

interface DiffScrollProps {
  children: React.ReactNode;
  scrollViewWidth: number;
  onScrollViewWidthChange: (width: number) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export function DiffScroll({
  children,
  scrollViewWidth,
  onScrollViewWidthChange,
  style,
  contentContainerStyle,
}: DiffScrollProps) {
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const horizontalScroll = useHorizontalScrollOptional();
  const scrollId = useId();
  const scrollViewRef = useRef<ScrollViewType>(null);

  // Get the close gesture ref from animation context (may not be available outside sidebar)
  let closeGestureRef: React.MutableRefObject<any> | undefined;
  try {
    const animation = useExplorerSidebarAnimation();
    closeGestureRef = animation.closeGestureRef;
  } catch {
    // Not inside ExplorerSidebarAnimationProvider, which is fine
  }

  // Register/unregister scroll offset tracking
  useEffect(() => {
    if (!horizontalScroll) return;
    // Start at 0 (not scrolled)
    horizontalScroll.registerScrollOffset(scrollId, 0);
    return () => {
      horizontalScroll.unregisterScrollOffset(scrollId);
    };
  }, [horizontalScroll, scrollId]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      // Track if we're at the left edge (with small threshold for float precision)
      setIsAtLeftEdge(offsetX <= 1);
      if (horizontalScroll) {
        horizontalScroll.registerScrollOffset(scrollId, offsetX);
      }
    },
    [horizontalScroll, scrollId],
  );

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      bounces={false}
      style={style}
      contentContainerStyle={contentContainerStyle}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onLayout={(e: LayoutChangeEvent) => onScrollViewWidthChange(e.nativeEvent.layout.width)}
      // When at left edge, wait for close gesture to fail before scrolling.
      // The close gesture fails quickly on leftward swipes (failOffsetX=-10),
      // so scrolling left works normally. On rightward swipes, close gesture
      // activates and closes the sidebar.
      waitFor={isAtLeftEdge && closeGestureRef?.current ? closeGestureRef : undefined}
    >
      {children}
    </ScrollView>
  );
}
