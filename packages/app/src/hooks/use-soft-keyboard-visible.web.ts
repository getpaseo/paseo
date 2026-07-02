import { useSyncExternalStore } from "react";

// Browsers have no reliable soft-keyboard-visibility signal (the visual-viewport
// heuristic breaks across mobile viewport configs), so approximate with the device
// capability: a coarse primary pointer means touch, i.e. a soft keyboard is in use.
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function getPointerQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(COARSE_POINTER_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const query = getPointerQuery();
  if (!query) {
    return () => {};
  }
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function getSnapshot(): boolean {
  return getPointerQuery()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useSoftKeyboardVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
