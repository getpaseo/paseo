import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const FOOTER_HEIGHT = 88;

interface FooterControlsContextValue {
  controls: ReactNode | null;
  registerFooterControls: (controls: ReactNode) => void;
  unregisterFooterControls: () => void;
}

const FooterControlsContext = createContext<FooterControlsContextValue | undefined>(undefined);

export function FooterControlsProvider({ children }: { children: ReactNode }) {
  const [controls, setControls] = useState<ReactNode | null>(null);

  const registerFooterControls = useCallback((nextControls: ReactNode) => {
    setControls(nextControls);
  }, []);

  const unregisterFooterControls = useCallback(() => {
    setControls(null);
  }, []);

  const value = useMemo(
    () => ({
      controls,
      registerFooterControls,
      unregisterFooterControls,
    }),
    [controls, registerFooterControls, unregisterFooterControls],
  );

  return (
    <FooterControlsContext.Provider value={value}>
      {children}
    </FooterControlsContext.Provider>
  );
}

export function useFooterControls() {
  const context = useContext(FooterControlsContext);

  if (!context) {
    throw new Error("useFooterControls must be used within a FooterControlsProvider");
  }

  return context;
}
