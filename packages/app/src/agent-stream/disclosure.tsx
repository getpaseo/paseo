import { createContext, useContext, useMemo, type ReactNode, type RefObject } from "react";
import type { StreamViewportHandle } from "./strategy";

/**
 * Runs a disclosure's state change. Inside a timeline row, the row that owns the
 * trigger keeps its screen position through the change; elsewhere `apply` runs as is.
 */
export type DisclosureHold = (apply: () => void) => void;

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
    () => (apply) => {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.holdRow(rowId, apply);
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
