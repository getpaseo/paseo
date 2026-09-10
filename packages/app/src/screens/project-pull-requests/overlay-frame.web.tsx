import { useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";

export function OverlayFrame({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const layer = useGlobalWebOverlayLayer("modal", true);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  const scopeRef = useWebOverlayRegistration({ active: true, layer, onKeyDown });
  const frameStyle = useMemo(() => [styles.frame, { zIndex: layer }], [layer]);
  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <View
        ref={scopeRef}
        role="dialog"
        aria-modal
        tabIndex={-1}
        style={frameStyle}
        testID="project-pr-overlay"
      >
        {children}
      </View>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}
const styles = StyleSheet.create({
  // A bounded viewport lets the list shrink and scroll instead of sizing the overlay to its rows.
  frame: { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "auto" },
});
