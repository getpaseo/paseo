import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

interface DiffScrollProps {
  children: React.ReactNode;
  scrollViewWidth: number;
  onScrollViewWidthChange: (width: number) => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export function DiffScroll({
  children,
  onScrollViewWidthChange,
  onScroll,
  style,
  contentContainerStyle,
}: DiffScrollProps) {
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={style}
      contentContainerStyle={contentContainerStyle}
      onScroll={onScroll}
      onLayout={(e: LayoutChangeEvent) => onScrollViewWidthChange(e.nativeEvent.layout.width)}
    >
      {children}
    </ScrollView>
  );
}
