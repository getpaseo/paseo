import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import {
  createAnimatedComponent,
  useAnimatedScrollHandler,
  type SharedValue,
} from "react-native-reanimated";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useFileExplorerCloseGestureRef } from "@/mobile-panels/gestures";
import { horizontalOffsetForPath, type DiffHorizontalOffsets } from "./horizontal-offsets";
import type { DiffFileSection } from "./types";

const AnimatedHorizontalScrollView = createAnimatedComponent(ScrollView);

export function HorizontalScroll({
  file,
  offsets,
}: {
  file: DiffFileSection;
  offsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const scrollRef = useRef<ScrollViewType>(null);
  const closeGestureRef = useFileExplorerCloseGestureRef();
  const horizontalScroll = useHorizontalScrollOptional();
  const scrollId = useId();
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const edgeRef = useRef(true);
  const handler = useAnimatedScrollHandler({
    onScroll(event) {
      offsets.value = { ...offsets.value, [file.path]: event.contentOffset.x };
    },
  });
  useEffect(() => {
    return () => horizontalScroll?.unregisterScrollOffset(scrollId);
  }, [horizontalScroll, scrollId]);
  useLayoutEffect(() => {
    const retainedOffset = horizontalOffsetForPath(offsets.value, file.path);
    scrollRef.current?.scrollTo({ x: retainedOffset, animated: false });
    const nextAtEdge = retainedOffset <= 1;
    edgeRef.current = nextAtEdge;
    setIsAtLeftEdge(nextAtEdge);
    horizontalScroll?.registerScrollOffset(scrollId, retainedOffset);
  }, [file.path, horizontalScroll, offsets, scrollId]);
  const reportOffset = useCallback(
    (event: { nativeEvent: { contentOffset: { x: number } } }) => {
      const offset = event.nativeEvent.contentOffset.x;
      const nextAtEdge = offset <= 1;
      if (nextAtEdge !== edgeRef.current) {
        edgeRef.current = nextAtEdge;
        setIsAtLeftEdge(nextAtEdge);
      }
      horizontalScroll?.registerScrollOffset(scrollId, offset);
    },
    [horizontalScroll, scrollId],
  );
  const beginHorizontalGesture = useCallback(() => {
    horizontalScroll?.beginHorizontalGesture(horizontalOffsetForPath(offsets.value, file.path));
  }, [file.path, horizontalScroll, offsets]);
  const endHorizontalGesture = useCallback(() => {
    horizontalScroll?.endHorizontalGesture();
  }, [horizontalScroll]);
  const rootStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: 0,
      right: 0,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight],
  );
  const spacerStyle = useMemo(
    () => ({
      width: file.contentWidth,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight, file.contentWidth],
  );
  return (
    <AnimatedHorizontalScrollView
      ref={scrollRef}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      bounces={false}
      style={rootStyle}
      contentContainerStyle={spacerStyle}
      onScroll={handler}
      onTouchStart={beginHorizontalGesture}
      onTouchEnd={endHorizontalGesture}
      onTouchCancel={endHorizontalGesture}
      onScrollEndDrag={reportOffset}
      scrollEventThrottle={16}
      waitFor={isAtLeftEdge && closeGestureRef?.current ? closeGestureRef : undefined}
      onMomentumScrollEnd={reportOffset}
    >
      <View style={spacerStyle} />
    </AnimatedHorizontalScrollView>
  );
}
