import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
