import { createContext, useContext } from "react";
import { isNative } from "@/constants/platform";

/** The native viewport reserves top clearance under the overlay; web stays in flow. */
export const supportsStreamTopOverlay = isNative;

const StreamTopOverlayContext = createContext(0);

/** Visual-top clearance supplied by the containing layout, in points. */
export const StreamTopOverlayProvider = StreamTopOverlayContext.Provider;

export function useStreamTopOverlayInset(): number {
  return useContext(StreamTopOverlayContext);
}
