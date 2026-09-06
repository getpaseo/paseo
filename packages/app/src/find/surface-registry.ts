import type { PaneHost } from "@/panels/panel-manifest";

/**
 * A mounted find surface. The hook owns the object and mutates it in place, so the
 * registry always reads the surface's current openness, interactivity, and root.
 */
export interface FindSurfaceRegistration {
  key: string;
  getRoot: () => HTMLElement | null;
  isInteractive: boolean;
  host: PaneHost;
  isOpen: boolean;
}

/**
 * Find is web-only (keyboard/availability.ts), so the base module is inert: surfaces
 * still register on native, nothing ever resolves as active, and no keyboard handler
 * or shortcut can fire. See surface-registry.web.ts for the real resolution.
 */
export function registerFindSurface(_surface: FindSurfaceRegistration): () => void {
  return () => {};
}

export function resolveActiveFindSurface(): FindSurfaceRegistration | null {
  return null;
}

export function isFindOpenForActiveSurface(): boolean {
  return false;
}
