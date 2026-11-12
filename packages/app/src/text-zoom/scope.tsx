import { createContext, useContext, type ReactNode } from "react";
import type { TextZoomSurface } from "./model";
import { useTextZoom } from "./store";

const TextZoomSurfaceContext = createContext<TextZoomSurface | null>(null);

/** Text rendered inside follows that surface's zoom. */
export function TextZoomScope({
  surface,
  children,
}: {
  surface: TextZoomSurface;
  children: ReactNode;
}) {
  return (
    <TextZoomSurfaceContext.Provider value={surface}>{children}</TextZoomSurfaceContext.Provider>
  );
}

/**
 * The zoom of the surface this component renders in, or 1 outside any. Shared components such as
 * Markdown read it, so the chat's zoom reaches them without changing plugin panels or file views.
 */
export function useScopedTextZoom(): number {
  return useTextZoom(useContext(TextZoomSurfaceContext));
}
