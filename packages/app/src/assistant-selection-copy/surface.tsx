import type { ReactNode, Ref } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The surface view, which find registers as the transcript pane's root. */
  ref?: Ref<View>;
}

export function AssistantSelectionCopySurface({
  children,
  style,
  ref,
}: AssistantSelectionCopySurfaceProps) {
  return (
    <View ref={ref} style={style}>
      {children}
    </View>
  );
}
