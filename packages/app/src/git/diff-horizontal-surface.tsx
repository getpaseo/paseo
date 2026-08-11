import { createContext, useContext, useMemo, type ReactNode } from "react";
import { type LayoutChangeEvent, type StyleProp, type ViewStyle, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { DiffScroll } from "@/components/diff-scroll";

const FILL: ViewStyle = { flex: 1 };
const CLIP: ViewStyle = { flex: 1, overflow: "hidden" };

const DiffHorizontalOffsetContext = createContext<SharedValue<number> | null>(null);

export function DiffHorizontalSurface({
  children,
  contentWidth,
  viewportWidth,
  onViewportWidthChange,
}: {
  children: ReactNode;
  contentWidth: number;
  viewportWidth: number;
  onViewportWidthChange: (width: number) => void;
}) {
  const offset = useSharedValue(0);
  const pinnedViewportStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));
  const contentContainerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [{ flexGrow: 1 }, { minWidth: Math.max(viewportWidth, contentWidth) }],
    [contentWidth, viewportWidth],
  );
  return (
    <DiffHorizontalOffsetContext.Provider value={offset}>
      <DiffScroll
        offset={offset}
        onScrollViewWidthChange={onViewportWidthChange}
        style={FILL}
        contentContainerStyle={contentContainerStyle}
        testID="diff-horizontal-scroll"
      >
        <Animated.View style={[FILL, { width: viewportWidth }, pinnedViewportStyle]}>
          {children}
        </Animated.View>
      </DiffScroll>
    </DiffHorizontalOffsetContext.Provider>
  );
}

export function DiffHorizontalContent({
  children,
  viewportStyle,
  contentStyle,
  onContentLayout,
  testID,
}: {
  children: ReactNode;
  viewportStyle?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  onContentLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
}) {
  const offset = useContext(DiffHorizontalOffsetContext);
  const translatedContentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -(offset?.value ?? 0) }],
  }));

  return (
    <View style={[CLIP, viewportStyle]}>
      <Animated.View
        style={[contentStyle, translatedContentStyle]}
        onLayout={onContentLayout}
        testID={testID}
      >
        {children}
      </Animated.View>
    </View>
  );
}
