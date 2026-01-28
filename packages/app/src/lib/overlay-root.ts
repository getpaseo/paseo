/**
 * Shared overlay root for web portals (modals, toasts, etc.)
 * This ensures consistent stacking order by controlling a single overlay container.
 *
 * Z-index scale within overlay root:
 * - Modal backdrop/content: 10
 * - Toast: 20
 */
export function getOverlayRoot(): HTMLElement {
  let el = document.getElementById("overlay-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "overlay-root";
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
  }
  return el;
}

export const OVERLAY_Z = {
  modal: 10,
  toast: 20,
} as const;
