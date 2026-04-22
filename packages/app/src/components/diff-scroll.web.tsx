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

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={[style, webScrollbarStyle]}
      contentContainerStyle={contentContainerStyle}
      onLayout={(e: LayoutChangeEvent) => onScrollViewWidthChange(e.nativeEvent.layout.width)}
    >
      {children}
    </ScrollView>
  );
}
