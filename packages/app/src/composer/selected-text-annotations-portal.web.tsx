import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { getContentAdornmentRoot } from "@/lib/overlay-root";

interface SelectedTextAnnotationsPortalProps {
  children: ReactNode;
  hostName: string;
  hostStyle: StyleProp<ViewStyle>;
  webStyle: StyleProp<ViewStyle>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function SelectedTextAnnotationsPortal({
  children,
  webStyle,
  onPointerEnter,
  onPointerLeave,
}: SelectedTextAnnotationsPortalProps) {
  return createPortal(
    <View
      pointerEvents="auto"
      style={webStyle}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      testID="composer-selected-text-annotations-details"
    >
      {children}
    </View>,
    getContentAdornmentRoot(),
  );
}
