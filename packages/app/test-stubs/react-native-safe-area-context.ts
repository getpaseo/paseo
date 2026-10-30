import { createContext, useContext } from "react";

// The package ships untranspiled Flow, which the unit project cannot parse. Like the real package,
// the hook reads the insets context; outside a provider the insets are zero.
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const;

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const SafeAreaInsetsContext = createContext<EdgeInsets | null>(ZERO_INSETS);
export const useSafeAreaInsets = () => useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const SafeAreaProvider = ({ children }: { children?: unknown }) => children;
export const SafeAreaView = ({ children }: { children?: unknown }) => children;
export const initialWindowMetrics = {
  insets: ZERO_INSETS,
  frame: { x: 0, y: 0, width: 0, height: 0 },
};
