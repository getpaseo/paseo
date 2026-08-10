import type { ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useWindowChromeRowPlacement, WindowChromeSafeArea } from "@/utils/desktop-window";

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
 * Windows/Linux: the controls sit in the top-right, on top of the row's trailing actions,
 * where padding would squash them toward the middle. The row reserves their height in a
 * strip above itself and starts below them instead.
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
  const placement = useWindowChromeRowPlacement();

  if (placement === "inline") {
    return (
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={horizontalPadding}
        onLayout={onLayout}
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
        onLayout={onLayout}
        style={[style, { paddingHorizontal: horizontalPadding }]}
        testID={testID}
      >
        {children}
      </View>
    </>
  );
}
