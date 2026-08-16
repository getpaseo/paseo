import type { ReactNode } from "react";
import { Portal } from "@gorhom/portal";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface SelectedTextAnnotationsPortalProps {
  children: ReactNode;
  hostName: string;
  hostStyle: StyleProp<ViewStyle>;
  webStyle: StyleProp<ViewStyle>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function SelectedTextAnnotationsPortal({
  children,
  hostName,
  hostStyle,
  onPointerEnter,
  onPointerLeave,
}: SelectedTextAnnotationsPortalProps) {
  return (
    <Portal hostName={hostName}>
      <View style={styles.overlay} pointerEvents="box-none">
        <View
          style={hostStyle}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          testID="composer-selected-text-annotations-details"
        >
          {children}
        </View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    zIndex: 1002,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
});
