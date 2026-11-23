// Remembers the last host element that held focus outside any browser guest.
// Agent CDP clicks focus a `<webview>` with a null `relatedTarget` (#4679).

let lastHostFocus: HTMLElement | null = null;
let installed = false;

function handleFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.tagName !== "WEBVIEW") {
    lastHostFocus = target;
  }
}

export function trackLastHostFocus(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("focusin", handleFocusIn, true);
}

export function getLastHostFocus(): HTMLElement | null {
  return lastHostFocus?.isConnected ? lastHostFocus : null;
}
