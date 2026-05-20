import {
  forwardRef,
  useMemo,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  StyleSheet,
  type ScrollViewProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";

export interface FloatingSurfaceProps extends Omit<ComponentProps<typeof Animated.View>, "style"> {
  frameStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}

export const FloatingSurface = forwardRef<View, FloatingSurfaceProps>(function FloatingSurface(
  { frameStyle, style, ...props },
  ref,
): ReactElement {
  return (
    <div style={StyleSheet.flatten(frameStyle) as CSSProperties | undefined}>
      <Animated.View {...props} ref={ref} style={style} />
    </div>
  );
});

export interface FloatingScrollViewProps {
  bounces?: boolean;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  showsVerticalScrollIndicator?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function FloatingScrollView({
  children,
  contentContainerStyle,
  style,
}: FloatingScrollViewProps): ReactElement {
  const viewportStyle = useMemo(
    () => ({
      ...(StyleSheet.flatten(style) as CSSProperties | undefined),
      overflowX: "hidden" as const,
      overflowY: "auto" as const,
    }),
    [style],
  );
  const bodyStyle = useMemo(
    () => StyleSheet.flatten(contentContainerStyle) as CSSProperties | undefined,
    [contentContainerStyle],
  );

  return (
    <div style={viewportStyle}>
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}
