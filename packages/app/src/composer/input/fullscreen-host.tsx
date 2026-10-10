import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import {
  getOverlayRoot,
  useOverlayLayer,
  OverlayLayerProvider,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";

export function ComposerFullscreenHost({
  children,
  onExit,
  active,
}: {
  children: ReactNode;
  onExit: () => void;
  active: boolean;
}) {
  const layer = useOverlayLayer("modal");
  const registration = useWebOverlayRegistration({
    active,
    layer,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onExit();
      return true;
    },
  });
  const frameStyle = useMemo(
    () => ({
      display: active ? ("flex" as const) : ("none" as const),
      position: "absolute" as const,
      inset: 0,
      zIndex: layer,
      pointerEvents: "auto" as const,
      height: "100%" as const,
    }),
    [active, layer],
  );
  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <View ref={registration} style={frameStyle}>
        {children}
      </View>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}
