import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";

// A touch tablet running the desktop layout is still `isWeb === false || true`
// depending on the build, so neither platform gate answers "can this user
// hover and point precisely" or "can this user touch the screen". Only the
// media queries do, and the same queries notify when the answer changes
// (detachable keyboards, tablet mode, devtools touch emulation).
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const TOUCH_SCREEN_QUERY = "(any-pointer: coarse)";

export interface PointerCapabilities {
  /** A mouse-like pointer drives the UI. */
  finePointer: boolean;
  /** A touch screen is available, possibly next to a mouse on hybrid devices. */
  touchScreen: boolean;
}

type MatchMedia = (query: string) => MediaQueryList;

export interface PointerCapabilitiesSource {
  getSnapshot: () => PointerCapabilities;
  subscribe: (onChange: () => void) => () => void;
}

export function createPointerCapabilitiesSource(
  matchMedia: MatchMedia | null,
): PointerCapabilitiesSource {
  const finePointerQuery = matchMedia?.(FINE_POINTER_QUERY) ?? null;
  const touchScreenQuery = matchMedia?.(TOUCH_SCREEN_QUERY) ?? null;
  let snapshot: PointerCapabilities = { finePointer: false, touchScreen: false };

  return {
    getSnapshot() {
      const finePointer = finePointerQuery?.matches ?? false;
      const touchScreen = touchScreenQuery?.matches ?? false;
      if (snapshot.finePointer !== finePointer || snapshot.touchScreen !== touchScreen) {
        snapshot = { finePointer, touchScreen };
      }
      return snapshot;
    },
    subscribe(onChange) {
      finePointerQuery?.addEventListener("change", onChange);
      touchScreenQuery?.addEventListener("change", onChange);
      return () => {
        finePointerQuery?.removeEventListener("change", onChange);
        touchScreenQuery?.removeEventListener("change", onChange);
      };
    },
  };
}

function browserMatchMedia(): MatchMedia | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return (query) => window.matchMedia(query);
}

// Native builds run on iOS and Android touch screens. A paired mouse or pen is
// filtered per gesture event by its pointer type, not by this capability.
const NATIVE_POINTER_CAPABILITIES: PointerCapabilities = { finePointer: false, touchScreen: true };
const nativeSource: PointerCapabilitiesSource = {
  getSnapshot: () => NATIVE_POINTER_CAPABILITIES,
  subscribe: () => () => {},
};

const source = isWeb ? createPointerCapabilitiesSource(browserMatchMedia()) : nativeSource;
const SERVER_SNAPSHOT: PointerCapabilities = { finePointer: false, touchScreen: false };

function getServerSnapshot(): PointerCapabilities {
  return SERVER_SNAPSHOT;
}

export function usePointerCapabilities(): PointerCapabilities {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, getServerSnapshot);
}

/** True when a mouse-like pointer drives the UI, read at call time. */
export function hasFinePointer(): boolean {
  return source.getSnapshot().finePointer;
}

/** Touch sizing remains enabled on hybrid browsers that report touch points. */
export function hasTouchScreen(): boolean {
  return (
    source.getSnapshot().touchScreen ||
    (isWeb && typeof window !== "undefined" && window.navigator.maxTouchPoints > 0)
  );
}
