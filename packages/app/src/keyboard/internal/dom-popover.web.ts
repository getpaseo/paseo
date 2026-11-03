/**
 * True while an element shown with the Popover API is open. Such a layer
 * floats above the app like a registered overlay but lives outside the
 * registry: plugins draw their panels this way, since they cannot register.
 */
export function hasOpenDomPopover(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.querySelector(":popover-open") !== null;
  } catch {
    // An engine without the Popover API rejects the selector, and has none open.
    return false;
  }
}

/**
 * Whether a key belongs to an open popover rather than to the app's shortcuts.
 * An open popover (a plugin's panel) is the top layer and closes on its own
 * Escape listener, which runs after the shortcut engine's capture listener:
 * Escape must not also interrupt the running agent.
 */
export function keyBelongsToDomPopover(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "Escape" && hasOpenDomPopover();
}
