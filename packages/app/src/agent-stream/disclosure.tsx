import { createContext, useContext, useMemo, type ReactNode, type RefObject } from "react";
import type { DisclosureTriggerEdge, StreamViewportHandle } from "./strategy";

/**
 * Runs a disclosure's state change. Inside a timeline row, the trigger keeps its screen
 * position through the change; elsewhere `apply` runs as is. A trigger below the content it
 * opens passes `triggerEdge: "bottom"`.
 */
export type DisclosureHold = (
  apply: () => void,
  options?: { triggerEdge?: DisclosureTriggerEdge },
) => void;

const applyInPlace: DisclosureHold = (apply) => apply();

const DisclosureHoldContext = createContext<DisclosureHold>(applyInPlace);

export function DisclosureRow({
  rowId,
  viewportRef,
  children,
}: {
  rowId: string;
  viewportRef: RefObject<StreamViewportHandle | null>;
  children: ReactNode;
}) {
  const hold = useMemo<DisclosureHold>(
    () => (apply, options) => {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.holdRow(rowId, apply, options?.triggerEdge ?? "top");
      } else {
        apply();
      }
    },
    [rowId, viewportRef],
  );
  return <DisclosureHoldContext.Provider value={hold}>{children}</DisclosureHoldContext.Provider>;
}

/** Call with the toggle's state change: `hold(() => setExpanded(!expanded))`. */
export function useDisclosureHold(): DisclosureHold {
  return useContext(DisclosureHoldContext);
}
