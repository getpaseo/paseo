import { useEffect, useState } from "react";
import { isWeb } from "@/constants/platform";

// A touch tablet running the desktop layout is still `isWeb === false || true`
// depending on the build, so neither platform gate answers "can this user
// hover and point precisely". Only the media query does.
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function getFinePointerQueryList(): MediaQueryList | null {
  if (!isWeb || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(FINE_POINTER_QUERY);
}

/** True when a mouse-like pointer drives the UI. Always false on native. */
export function hasFinePointer(): boolean {
  return getFinePointerQueryList()?.matches ?? false;
}

/**
 * Reactive `hasFinePointer()` — re-renders when the user switches between a
 * mouse and touch (detachable keyboards, tablet mode).
 */
export function useHasFinePointer(): boolean {
  const [finePointer, setFinePointer] = useState(hasFinePointer);

  useEffect(() => {
    const mediaQuery = getFinePointerQueryList();
    if (!mediaQuery) return;
    const handleChange = () => setFinePointer(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener?.("change", handleChange);
    return () => {
      mediaQuery.removeEventListener?.("change", handleChange);
    };
  }, []);

  return finePointer;
}
