import { useSyncExternalStore } from "react";
import { Dimensions } from "react-native";

interface DimensionSource {
  get(kind: "window" | "screen"): { width: number; height: number };
}

function subscribe(listener: () => void): () => void {
  const subscription = Dimensions.addEventListener("change", listener);
  return () => subscription.remove();
}

/**
 * Shortest side of the physical screen, in layout units.
 *
 * The workspace deck's retention gate must not read `useWindowDimensions()`: Android runs with
 * `softwareKeyboardLayoutMode: "resize"`, so the window loses the keyboard's height and any gate on
 * the window's shortest side flips as soon as the composer opens — which unmounts the retained
 * workspaces and throws away their terminals and scroll positions. The screen size ignores the
 * keyboard and split-screen; it changes only when the display itself does (a fold, a rotation that
 * swaps the sides, a resolution change).
 */
export function readShortestScreenSide(source: DimensionSource): number {
  const { width, height } = source.get("screen");
  return Math.min(width, height);
}

export function useScreenShortestSide(): number {
  return useSyncExternalStore(subscribe, readFromDimensions, readFromDimensions);
}

function readFromDimensions(): number {
  return readShortestScreenSide(Dimensions);
}
