import type { ReactNode } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export function AssistantSelectionCopySurface({
  children,
  style,
  onLayout,
}: AssistantSelectionCopySurfaceProps) {
  return (
    <View style={style} onLayout={onLayout}>
      {children}
    </View>
  );
}
