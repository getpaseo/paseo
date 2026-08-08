// A stack of dismissible web overlays (dialogs, sheets, popovers) that claim the
// Escape key. It carries two responsibilities:
//
//   1. Run the topmost overlay's close handler when Escape is pressed. This
//      module owns the window keydown listener, so overlays still close on
//      Escape even on routes where the global keyboard-shortcut dispatcher is
//      disabled.
//   2. Expose `hasEscapeDismissHandler()` so the dispatcher can suppress the
//      Escape-bound `agent.interrupt` shortcut while an overlay is open.
//
// Without (2), cancelling a dialog with Escape also interrupts a running agent:
// the dispatcher's capture-phase window listener registers first (at app mount)
// and routes `agent.interrupt` before this listener — registered later, when the
// overlay opens — gets to close the overlay. `stopPropagation` cannot prevent
// that because both listeners sit on the same target (window) in the same phase.
//
// The stack core is pure and DOM-free; the window listener is a thin adapter
// guarded by `typeof window`, so the LIFO behaviour is exercised in plain Node.
//
// Scope: this stack serves overlays that keep focus outside themselves — the
// composer autocomplete popover (the text input must stay focused), the inline
// review-comment editor, the attachment lightbox. Layered overlays that trap
// focus (dialogs, dropdowns, comboboxes) register with `useWebOverlayRegistration`
// in `@/lib/overlay-root` instead; the dispatcher gate reads both via
// `hasOpenWebOverlay() || hasEscapeDismissHandler()`.

type EscapeDismissHandler = () => void;

const handlers: EscapeDismissHandler[] = [];
let listenerAttached = false;

/** Run the topmost overlay's close handler. Returns false if none are open. */
export function runTopEscapeDismissHandler(): boolean {
  const handler = handlers[handlers.length - 1];
  if (!handler) return false;
  handler();
  return true;
}

/** True while at least one dismissible overlay is open. */
export function hasEscapeDismissHandler(): boolean {
  return handlers.length > 0;
}

function handleEscapeKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (!runTopEscapeDismissHandler()) return;
  // The overlay owns this Escape — keep it from reaching the terminal or any
  // bubble-phase handler now that the topmost overlay has handled it.
  event.stopPropagation();
  event.preventDefault();
}

/**
 * Register `handler` as the close action for a newly opened overlay. The returned
 * disposer removes it again; call it when the overlay closes/unmounts.
 */
export function pushEscapeDismissHandler(handler: EscapeDismissHandler): () => void {
  // All callers register only from web overlays (e.g. AdaptiveModalSheet gates on
  // `isWeb`), so `window` always exists here and the invariant "stack non-empty ⇒
  // listener attached" holds. If a non-browser caller is ever added, the handler
  // would sit on the stack with no listener until a later browser-side push.
  handlers.push(handler);
  if (!listenerAttached && typeof window !== "undefined") {
    window.addEventListener("keydown", handleEscapeKeyDown, true);
    listenerAttached = true;
  }
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
    if (handlers.length === 0 && listenerAttached && typeof window !== "undefined") {
      window.removeEventListener("keydown", handleEscapeKeyDown, true);
      listenerAttached = false;
    }
  };
}
