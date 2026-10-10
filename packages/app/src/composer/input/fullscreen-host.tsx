import { useMemo, useLayoutEffect, useState, type ReactNode } from "react";
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
  const [viewport, setViewport] = useState(readVisibleViewport);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setViewport(readVisibleViewport());
    const visualViewport = window.visualViewport;
    update();
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  const frameStyle = useMemo(
    () => ({
      display: active ? ("flex" as const) : ("none" as const),
      position: "absolute" as const,
      top: viewport.top,
      left: viewport.left,
      width: viewport.width,
      zIndex: layer,
      pointerEvents: "auto" as const,
      height: viewport.height,
    }),
    [active, layer, viewport],
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

function readVisibleViewport() {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}
