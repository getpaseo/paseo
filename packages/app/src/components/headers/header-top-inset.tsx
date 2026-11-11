import { createContext, useContext, type ReactNode } from "react";
import { WindowLayoutTopInset } from "@/window-layout";

const HeaderTopInsetOwnedContext = createContext(false);

export function HeaderTopInset({ additionalPadding = 0 }: { additionalPadding?: number }) {
  const owned = useContext(HeaderTopInsetOwnedContext);
  return owned ? null : <WindowLayoutTopInset additionalPadding={additionalPadding} />;
}

/** Keep native clearance mounted while the header below it changes presentation. */
export function HeaderTopInsetHost({
  active,
  additionalPadding,
  children,
}: {
  active: boolean;
  additionalPadding: number;
  children: ReactNode;
}) {
  return (
    <HeaderTopInsetOwnedContext.Provider value={active}>
      {active ? <WindowLayoutTopInset additionalPadding={additionalPadding} /> : null}
      {children}
    </HeaderTopInsetOwnedContext.Provider>
  );
}
