// The package ships untranspiled Flow, which the unit project cannot parse. Insets are a device
// fact no test asserts on, so they are zero.
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const;

export const useSafeAreaInsets = () => ZERO_INSETS;
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const SafeAreaProvider = ({ children }: { children?: unknown }) => children;
export const SafeAreaView = ({ children }: { children?: unknown }) => children;
export const initialWindowMetrics = {
  insets: ZERO_INSETS,
  frame: { x: 0, y: 0, width: 0, height: 0 },
};
