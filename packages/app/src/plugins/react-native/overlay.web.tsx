import type { OverlayProps } from "@getpaseo/plugin/client/react-native";
import { useCallback } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { OverlayLayer } from "./overlay-layer";

/**
 * Plugin overlays join the shared overlay root instead of React Native Web's `<Modal>`. That
 * modal traps focus on its own, so a host dialog opened over it (Command Center, a menu) fought it
 * for focus until the page hung. Here the relative layer model decides: the highest registered
 * scope alone gets Escape and focus, whether it is a nested plugin overlay or a host surface.
 */
export function Overlay({
  open,
  onClose,
  backdrop = "dim",
  accessibilityLabel,
  children,
}: OverlayProps) {
  const layer = useGlobalWebOverlayLayer("modal", open);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onClose();
      return true;
    },
    [onClose],
  );
  const setScope = useWebOverlayRegistration({
    active: open,
    layer,
    onKeyDown: handleKeyDown,
  });
  if (!open) return null;
  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <View
        ref={setScope}
        role="dialog"
        aria-modal
        aria-label={accessibilityLabel}
        tabIndex={-1}
        style={[styles.root, { zIndex: layer }]}
      >
        <OverlayLayer backdrop={backdrop} onClose={onClose}>
          {children}
        </OverlayLayer>
      </View>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, pointerEvents: "auto" },
});
