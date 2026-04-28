import { useCallback, useMemo } from "react";
import { ScrollView, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";

interface DiffScrollProps {
  children: React.ReactNode;
  scrollViewWidth: number;
  onScrollViewWidthChange: (width: number) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export function DiffScroll({
  children,
  onScrollViewWidthChange,
  style,
  contentContainerStyle,
}: DiffScrollProps) {
  const webScrollbarStyle = useWebScrollbarStyle();
  const combinedStyle = useMemo(() => [style, webScrollbarStyle], [style, webScrollbarStyle]);
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => onScrollViewWidthChange(e.nativeEvent.layout.width),
    [onScrollViewWidthChange],
  );

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={combinedStyle}
      contentContainerStyle={contentContainerStyle}
      onLayout={handleLayout}
    >
      {children}
    </ScrollView>
  );
}
