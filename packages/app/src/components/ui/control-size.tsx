import { createContext, useContext, type ReactNode } from "react";
import type { ControlSize } from "@/components/ui/control-geometry";

// A row decides how big its controls are, so a button or field placed in it needs no size of
// its own. A size passed to the control still wins.
const ControlSizeContext = createContext<ControlSize | null>(null);

export function ControlSizeProvider({
  size,
  children,
}: {
  size: ControlSize;
  children: ReactNode;
}) {
  return <ControlSizeContext.Provider value={size}>{children}</ControlSizeContext.Provider>;
}

/** The size the surrounding container asks for, or null outside one. */
export function useContainedControlSize(): ControlSize | null {
  return useContext(ControlSizeContext);
}
