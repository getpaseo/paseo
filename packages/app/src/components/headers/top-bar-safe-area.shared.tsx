import { createContext, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export const TopBarLeadingControlInsetContext = createContext(0);

export interface TopBarSafeAreaProps {
  children: ReactNode;
  /** Height of the content, excluding the wrapper's safe area and top padding. */
  contentHeight: number;
  /** Height of the first row aligned with a top-trailing system control region. */
  primaryRowHeight?: number;
  /** Navigation rows own their normal horizontal gutters; only the first row clears corners. */
  navigationGroup?: boolean;
  topPadding?: number;
  /** Padding already owned by children; bar margins must not add it again. */
  horizontalContentPadding?: number;
  /** Width allocated to this exact bar owner, before its native horizontal margins. */
  allocatedWidth?: number | null;
  style?: StyleProp<ViewStyle>;
  onAvailableWidth?: (width: number) => void;
  onHorizontalInsetsChange?: (left: number, right: number) => void;
}

export interface TopBarGeometry {
  top: number;
  left: number;
  right: number;
  availableWidth: number;
  ownerWidth: number;
  ownerLeadingOffset: number;
  leadingCornerInset: number;
  requiresLeadingCornerSlot: boolean;
  alignmentCenterY: number | null;
}

interface TopBarSafeAreaFrameProps extends TopBarSafeAreaProps {
  geometry: Pick<TopBarGeometry, "top" | "left" | "right">;
  probe?: ReactNode;
  availableWidth?: number;
  leadingControlInset?: number;
}

export function TopBarSafeAreaFrame({
  children,
  topPadding = 0,
  style,
  onAvailableWidth,
  geometry,
  probe,
  availableWidth,
  leadingControlInset = 0,
}: TopBarSafeAreaFrameProps) {
  const lastWidth = useRef<number | undefined>(undefined);
  const publishWidth = useCallback(
    (width: number) => {
      if (width >= 0 && width !== lastWidth.current) {
        lastWidth.current = width;
        onAvailableWidth?.(width);
      }
    },
    [onAvailableWidth],
  );
  const handleLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => {
      if (availableWidth === undefined) publishWidth(nativeEvent.layout.width);
    },
    [availableWidth, publishWidth],
  );
  useLayoutEffect(() => {
    if (availableWidth !== undefined) publishWidth(availableWidth);
  }, [availableWidth, publishWidth]);

  return (
    <View
      style={[
        styles.root,
        style,
        {
          paddingTop: geometry.top + topPadding,
          paddingLeft: geometry.left,
          paddingRight: geometry.right,
        },
      ]}
    >
      {probe}
      <View style={styles.content} onLayout={handleLayout}>
        <TopBarLeadingControlInsetContext value={leadingControlInset}>
          {children}
        </TopBarLeadingControlInsetContext>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexShrink: 0,
    alignSelf: "stretch",
  },
  content: {
    minWidth: 0,
    alignSelf: "stretch",
  },
});
