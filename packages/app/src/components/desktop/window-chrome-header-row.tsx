import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
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
  const contentRef = useRef<View>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [previousPlacement, setPreviousPlacement] = useState<"inline" | "below">("inline");

  const measureContentWidth = useCallback(() => {
    if (!isWeb) return;
    requestAnimationFrame(() => {
      const content = contentRef.current as unknown as HTMLElement | null;
      if (!content) return;
      // The row lays its children out with space-between, which stretches them to fill whatever
      // width it has. Reading them where they sit would measure the row back to itself and the
      // row would always look full. Collapse to max-content for the read so each child reports
      // the width it actually wants, then restore before the browser paints.
      const previousWidth = content.style.width;
      content.style.width = "max-content";
      const intrinsicWidth = content.scrollWidth + horizontalPadding * 2;
      content.style.width = previousWidth;
      setContentWidth((current) => (current === intrinsicWidth ? current : intrinsicWidth));
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

  // Measure after every commit, not only on layout. A row that never fires onLayout again --
  // the common case once the window settles -- would otherwise keep its first-paint placement
  // no matter what its content did, and only correct itself the next time something resized.
  // measureContentWidth writes the same number back when nothing moved, so this converges.
  useEffect(measureContentWidth);

  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setAvailableWidth((current) =>
        current === event.nativeEvent.layout.width ? current : event.nativeEvent.layout.width,
      );
      onLayout?.(event);
      measureContentWidth();
    },
    [measureContentWidth, onLayout],
  );
  const handleContentLayout = useCallback(() => measureContentWidth(), [measureContentWidth]);

  const content = (
    <View
      ref={contentRef}
      collapsable={false}
      onLayout={handleContentLayout}
      style={styles.content}
    >
      {children}
    </View>
  );

  if (placement === "inline") {
    return (
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={horizontalPadding}
        onLayout={handleRowLayout}
        style={style}
        testID={testID}
      >
        {content}
      </WindowChromeSafeArea>
    );
  }

  return (
    <>
      <WindowChromeSafeArea placement="below" style={stripStyle}>
        <TitlebarDragRegion />
      </WindowChromeSafeArea>
      <View
        onLayout={handleRowLayout}
        style={[style, { paddingHorizontal: horizontalPadding }]}
        testID={testID}
      >
        {content}
      </View>
    </>
  );
}

const styles = {
  content: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  },
};
