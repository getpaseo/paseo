import type { OverlayRegistration } from "./overlay-contract";
import { useLayoutEffect, useRef } from "react";
import { overlays } from "./overlays";

const setScope = (_node: unknown) => {};
export function useOverlayRegistration(input: OverlayRegistration) {
  const current = useRef(input);
  current.current = input;
  useLayoutEffect(() => {
    if (!input.active) return;
    return overlays.register({
      getLayer: () => current.current.layer,
      getKeys: () => current.current.keys,
      onKeyDown: (event) => current.current.onKeyDown(event),
    });
  }, [input.active]);
  return setScope;
}
