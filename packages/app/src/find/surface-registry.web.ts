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

export interface FindSurfaceRegistryPorts {
  getActiveElement: () => Element | null;
  /** Reports the target of every pointerdown in the document, capture phase. */
  addPointerListener: (listener: (target: Node | null) => void) => () => void;
}

export interface FindSurfaceRegistry {
  register: (surface: FindSurfaceRegistration) => () => void;
  resolveActive: () => FindSurfaceRegistration | null;
}

/**
 * Decides which surface owns Cmd+F right now.
 *
 * `usePaneFocus().isInteractive` cannot answer this on its own: the Explorer sidebar
 * host passes `isPaneFocused` as a constant true (screens/workspace/explorer-sidebar.tsx),
 * so its visible tab and the focused main pane are both interactive at the same time.
 * DOM focus decides first, the last pointerdown breaks the remaining tie, and the
 * interactive main pane is the fallback for a workspace nobody has clicked into yet.
 */
export function createFindSurfaceRegistry(ports: FindSurfaceRegistryPorts): FindSurfaceRegistry {
  const surfaces = new Set<FindSurfaceRegistration>();
  let lastPointerSurface: FindSurfaceRegistration | null = null;
  let removePointerListener: (() => void) | null = null;

  const handlePointerDown = (target: Node | null) => {
    if (!target) return;
    for (const surface of surfaces) {
      const root = surface.getRoot();
      if (root?.contains(target)) {
        lastPointerSurface = surface;
        return;
      }
    }
  };

  return {
    register(surface) {
      surfaces.add(surface);
      removePointerListener ??= ports.addPointerListener(handlePointerDown);

      return () => {
        surfaces.delete(surface);
        if (lastPointerSurface === surface) {
          lastPointerSurface = null;
        }
        if (surfaces.size === 0) {
          removePointerListener?.();
          removePointerListener = null;
        }
      };
    },

    resolveActive() {
      const activeElement = ports.getActiveElement();
      // document.body is what focus falls back to after a blur, which says nothing
      // about which pane the user is working in.
      if (activeElement && activeElement !== activeElement.ownerDocument.body) {
        for (const surface of surfaces) {
          if (surface.getRoot()?.contains(activeElement)) {
            return surface;
          }
        }
      }

      // A pointerdown that lands outside every root — a pane's own toolbar, an image,
      // the Explorer tab rail — leaves this entry in place on purpose, so clicking the
      // chrome around a surface does not hand Cmd+F to a different pane. `isInteractive`
      // is what stops it going stale: clicking into another pane moves pane focus, so a
      // surface the user has left stops answering and the resolution falls through
      // (to nothing, when the pane now in front has no find surface at all).
      if (lastPointerSurface?.isInteractive && surfaces.has(lastPointerSurface)) {
        return lastPointerSurface;
      }

      for (const surface of surfaces) {
        if (surface.isInteractive && surface.host === "main") {
          return surface;
        }
      }

      return null;
    },
  };
}

const registry = createFindSurfaceRegistry({
  getActiveElement: () => document.activeElement,
  addPointerListener: (listener) => {
    const handler = (event: PointerEvent) => {
      listener(event.target instanceof Node ? event.target : null);
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  },
});

export function registerFindSurface(surface: FindSurfaceRegistration): () => void {
  return registry.register(surface);
}

export function resolveActiveFindSurface(): FindSurfaceRegistration | null {
  return registry.resolveActive();
}

export function isFindOpenForActiveSurface(): boolean {
  return registry.resolveActive()?.isOpen ?? false;
}
