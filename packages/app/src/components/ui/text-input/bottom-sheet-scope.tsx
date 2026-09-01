import React, { createContext, useContext, type ReactNode } from "react";

const BottomSheetScopeContext = createContext(false);

export function BottomSheetTextInputScope({ children }: { children: ReactNode }) {
  return <BottomSheetScopeContext.Provider value>{children}</BottomSheetScopeContext.Provider>;
}

export function useIsInsideBottomSheet(): boolean {
  return useContext(BottomSheetScopeContext);
}
