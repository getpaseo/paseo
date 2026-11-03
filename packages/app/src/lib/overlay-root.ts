import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { getTopOverlayLayer } from "@/keyboard";

/**
 * Shared overlay root for web portals (modals, toasts, etc.)
 * This ensures consistent stacking order by controlling a single overlay container.
 *
 * Z-index scale within overlay root:
 * - Floating panel: parent layer + 10
 * - Modal: parent layer + 20
 * - Toast: 10,000
 * - Tooltip: 20,000
 *
 * Floating panels and modals provide their resolved layer to descendants. A
 * dropdown opened inside a modal therefore paints above that modal, while a
 * base dropdown remains below a modal opened over it.
 */
export function getOverlayRoot(): HTMLElement {
  let el = document.getElementById("overlay-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "overlay-root";
    document.body.appendChild(el);
  }
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.pointerEvents = "none";
  el.style.zIndex = String(WEB_SURFACE_PLANE.overlay);
  return el;
}

export const WEB_SURFACE_PLANE = {
  browser: 0,
  overlay: 1,
} as const;

export const OVERLAY_Z = {
  floating: 10,
  modal: 20,
  toast: 10_000,
  tooltip: 20_000,
} as const;

type OverlayKind = "floating" | "modal";

const OverlayLayerContext = createContext(0);

export function useOverlayLayer(kind: OverlayKind): number {
  return useContext(OverlayLayerContext) + OVERLAY_Z[kind];
}

/**
 * Resolves a globally hosted web overlay above whichever registered overlay
 * was topmost when it opened. Global hosts live outside their opener's React
 * tree, so context alone cannot preserve that relative ownership.
 */
export function useGlobalOverlayLayer(kind: OverlayKind, active: boolean): number {
  const contextualLayer = useOverlayLayer(kind);
  const captureOpening = () => ({
    active,
    contextualLayer,
    kind,
    layer: active
      ? Math.max(contextualLayer, getTopOverlayLayer() + OVERLAY_Z[kind])
      : contextualLayer,
  });
  const [opening, setOpening] = useState(captureOpening);
  if (
    opening.active !== active ||
    opening.contextualLayer !== contextualLayer ||
    opening.kind !== kind
  ) {
    const next = captureOpening();
    setOpening(next);
    return next.layer;
  }
  return opening.layer;
}

export function useCurrentOverlayLayer(): number {
  return useContext(OverlayLayerContext);
}

export function OverlayLayerProvider({ layer, children }: { layer: number; children?: ReactNode }) {
  return createElement(OverlayLayerContext.Provider, { value: layer }, children);
}
