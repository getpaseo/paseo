import { forwardRef, type ReactNode } from "react";
import {
  Animated,
  type ScrollView,
  type ScrollViewProps,
  View,
  type ViewStyle,
} from "react-native";

// While the stream follows its end, React Native's native content-position keeping holds a
// zero-height view at the bottom of the content still. It runs on the UI thread around each mount,
// so a row that grows or lands at the end scrolls in the same frame it lays out. LegendList's
// `maintainScrollAtEnd` scrolls from JS after the mount, which paints the growth below the viewport
// for a frame or more first.
//
// The anchor has to be the content's first native child: content-position keeping anchors on the
// first child at or after `minIndexForVisible` that reaches into the viewport, and every child
// LegendList renders can be flattened away. Absolute positioning keeps it out of the flow.
const END_ANCHOR_STYLE: ViewStyle = {
  position: "absolute",
  bottom: 0,
  left: 0,
  height: 0,
  width: 0,
};
const END_ANCHOR_POSITION = { minIndexForVisible: 0 };

interface EndPinnedScrollViewProps extends ScrollViewProps {
  pinEnd: boolean;
  children?: ReactNode;
}

export const EndPinnedScrollView = forwardRef<ScrollView, EndPinnedScrollViewProps>(
  function EndPinnedScrollView({ pinEnd, children, maintainVisibleContentPosition, ...rest }, ref) {
    return (
      <Animated.ScrollView
        {...rest}
        ref={ref}
        maintainVisibleContentPosition={
          pinEnd ? END_ANCHOR_POSITION : maintainVisibleContentPosition
        }
      >
        {pinEnd ? <View collapsable={false} pointerEvents="none" style={END_ANCHOR_STYLE} /> : null}
        {children}
      </Animated.ScrollView>
    );
  },
);
