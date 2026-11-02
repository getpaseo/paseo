import { createContext, useContext, type ReactNode } from "react";

/** The control sizes a container can ask of the controls placed in it. */
export type ContainedControlSize = "xs" | "sm";

// A row decides how big its controls are, so a button or field placed in it needs no size of
// its own. A size passed to the control still wins.
const ControlSizeContext = createContext<ContainedControlSize | null>(null);

export function ControlSizeProvider({
  size,
  children,
}: {
  size: ContainedControlSize;
  children: ReactNode;
}) {
  return <ControlSizeContext.Provider value={size}>{children}</ControlSizeContext.Provider>;
}

/** The size the surrounding container asks for, or null outside one. */
export function useContainedControlSize(): ContainedControlSize | null {
  return useContext(ControlSizeContext);
}
