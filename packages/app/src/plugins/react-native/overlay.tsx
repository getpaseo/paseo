import type { OverlayProps } from "@getpaseo/plugin/client/react-native";
import { Modal, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { OverlayLayer } from "./overlay-layer";

/**
 * A native modal window, because it is the one escape that keeps the plugin's React context: a
 * `@gorhom/portal` host would render the plugin's children without the providers around them.
 * Android delivers Back to the topmost modal window and nowhere else, so a nested overlay closes
 * before its parent, and both close before any sheet or navigator underneath.
 */
export function Overlay({
  open,
  onClose,
  backdrop = "dim",
  accessibilityLabel,
  children,
}: OverlayProps) {
  return (
    <Modal
      visible={open}
      transparent
      animationType={backdrop === "dim" ? "fade" : "none"}
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={onClose}
    >
      {/* Android opens the modal in its own window, outside the app's gesture root. */}
      <GestureHandlerRootView
        style={styles.root}
        accessibilityViewIsModal
        accessibilityLabel={accessibilityLabel}
      >
        <OverlayLayer backdrop={backdrop} onClose={onClose}>
          {children}
        </OverlayLayer>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
