import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

export function ComposerToolbarGlyph({ children, size }: { children: ReactNode; size: number }) {
  return (
    <View
      style={size >= 20 ? styles.touch : styles.pointer}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  pointer: {
    width: 16,
    height: 16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  touch: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
