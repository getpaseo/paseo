import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { resolveHeaderRowContentWidth } from "@/components/desktop/window-chrome-header-row-measure";
import { useWindowChromeRowPlacement, WindowChromeSafeArea } from "@/utils/desktop-window";
import { isWeb } from "@/constants/platform";

interface WindowChromeHeaderRowProps {
  children: ReactNode;
  /** Padding the row wants regardless of window chrome. */
  horizontalPadding?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Row style. Window chrome clearance is added on top of it. */
  style?: StyleProp<ViewStyle>;
  /** Style for the reserved strip. Ignored on macOS, which has no strip. */
  stripStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Reads the width a child wants when the row has stretched it past its own content. */
function measureMaxContentWidth(element: HTMLElement): number {
  const previousWidth = element.style.width;
  element.style.width = "max-content";
  const width = element.scrollWidth;
  element.style.width = previousWidth;
  return width;
}

/**
 * A header row that clears the native window controls, whichever corner they occupy.
 *
 * macOS: the traffic lights sit in the top-left, ahead of the row's leading content, so the
 * row stays inline and pads past them — the original layout, unchanged.
 *
 * Windows/Linux: the controls sit in the top-right, on top of the row's trailing actions.
 * The row measures itself and pads past them while it has width to spare; when its content
 * would no longer fit it reserves their height in a strip above itself and starts below them.
 *
 * Callers still render their own TitlebarDragRegion as the first child of the row; this
 * only adds the one covering the reserved strip.
 */
export function WindowChromeHeaderRow({
  children,
  horizontalPadding = 0,
  onLayout,
  style,
  stripStyle,
  testID,
}: WindowChromeHeaderRowProps) {
  const rowRef = useRef<View>(null);
  const frameRef = useRef<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [previousPlacement, setPreviousPlacement] = useState<"inline" | "below">("inline");

  const measureContentWidth = useCallback(() => {
    // Coalesce to one measurement per frame: several observers firing together read the same
    // layout, and the reads below flush it.
    if (!isWeb || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const content = rowRef.current as unknown as HTMLElement | null;
      if (!content) return;
      const gap = Number.parseFloat(window.getComputedStyle(content).columnGap) || 0;
      const childBoxes = Array.from(content.children).map((child) => {
        const childStyle = window.getComputedStyle(child);
        const isAbsolute = childStyle.position === "absolute";
        const canShrink = childStyle.flexShrink !== "0";
        // resolveHeaderRowContentWidth ignores a child that can shrink or is out of flow, so
        // don't pay to measure one. A child that can neither shrink nor grow is already laid
        // out at the width it wants; only a stretched one needs the max-content read, which
        // costs a reflow.
        if (isAbsolute || canShrink) return { isAbsolute, canShrink, intrinsicWidth: 0 };
        return {
          isAbsolute,
          canShrink,
          intrinsicWidth:
            childStyle.flexGrow === "0"
              ? child.getBoundingClientRect().width
              : measureMaxContentWidth(child as HTMLElement),
        };
      });
      const measuredWidth = resolveHeaderRowContentWidth({
        children: childBoxes,
        gap,
        horizontalPadding,
      });
      setContentWidth((current) => (current === measuredWidth ? current : measuredWidth));
    });
  }, [horizontalPadding]);

  const placement = useWindowChromeRowPlacement({
    availableWidth,
    contentWidth,
    previousPlacement,
  });

  useEffect(() => {
    setPreviousPlacement((current) => (current === placement ? current : placement));
  }, [placement]);

  // Measure when the child tree changes, when the row moves between placements, and whenever a
  // child's own box changes. Measuring after every commit instead re-ran the whole reflow for
  // state this row set itself, and once per frame of a window resize -- an intrinsic width does
  // not depend on the width the row was given. A child that updates its own text without
  // re-rendering this row never reaches the render path at all, which is what the observer is
  // for: the children that count are the ones that cannot shrink, and those lay out at their
  // intrinsic width, so their box moves with their content.
  useEffect(() => {
    measureContentWidth();
    if (!isWeb || typeof ResizeObserver === "undefined") return;
    const content = rowRef.current as unknown as HTMLElement | null;
    if (!content) return;
    const observer = new ResizeObserver(measureContentWidth);
    for (const child of Array.from(content.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [children, measureContentWidth, placement]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setAvailableWidth((current) =>
        current === event.nativeEvent.layout.width ? current : event.nativeEvent.layout.width,
      );
      onLayout?.(event);
    },
    [onLayout],
  );
  if (placement === "inline") {
    return (
      <WindowChromeSafeArea
        viewRef={rowRef}
        placement="inline"
        horizontalPadding={horizontalPadding}
        onLayout={handleRowLayout}
        style={style}
        testID={testID}
      >
        {children}
      </WindowChromeSafeArea>
    );
  }

  return (
    <>
      <WindowChromeSafeArea placement="below" style={stripStyle}>
        <TitlebarDragRegion />
      </WindowChromeSafeArea>
      <View
        ref={rowRef}
        onLayout={handleRowLayout}
        style={[style, { paddingHorizontal: horizontalPadding }]}
        testID={testID}
      >
        {children}
      </View>
    </>
  );
}
