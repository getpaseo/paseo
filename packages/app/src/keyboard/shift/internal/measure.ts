import { useMemo, type RefObject } from "react";
import type { View } from "react-native";
import type { KeyboardTranslation, KeyboardTranslationScope, WindowRect } from "./context";

export function measureInWindow(element: View): Promise<WindowRect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * The element's window rect with `frame`'s own transform left out. Whether
 * `measureInWindow` includes a transform depends on the driver: Reanimated commits
 * it to the shadow tree, RN's native driver commits it only when the view happens
 * to re-render. Fabric's `measureLayout` and a view's `measure` origin ignore
 * transforms. The frame's parent must not move with the keyboard; the composer dock
 * is the only anchor host, and its parent is the stationary dock viewport.
 */
function measureInUntranslatedWindow(frame: View, element: View): Promise<WindowRect | null> {
  const parent = frame.parentElement;
  if (!parent) return Promise.resolve(null);
  const parentRect = parent.getBoundingClientRect();
  const frameOrigin = new Promise<{ x: number; y: number }>((resolve) => {
    frame.measure((x, y) => resolve({ x, y }));
  });
  const offset = new Promise<WindowRect | null>((resolve) => {
    element.measureLayout(
      frame,
      (x, y, width, height) => resolve({ x, y, width, height }),
      () => resolve(null),
    );
  });
  return Promise.all([frameOrigin, offset]).then(([origin, rect]) =>
    rect
      ? {
          x: parentRect.x + origin.x + rect.x,
          y: parentRect.y + origin.y + rect.y,
          width: rect.width,
          height: rect.height,
        }
      : null,
  );
}

/** What a KeyboardTranslateView publishes to the content it moves. */
export function useKeyboardTranslationScope(
  frameRef: RefObject<View | null>,
  translation: KeyboardTranslation,
): KeyboardTranslationScope {
  return useMemo(
    () => ({
      translation,
      measureAtRest: (element: View) =>
        frameRef.current
          ? measureInUntranslatedWindow(frameRef.current, element)
          : Promise.resolve(null),
    }),
    [frameRef, translation],
  );
}
