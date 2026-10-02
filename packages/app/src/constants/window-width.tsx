import { createContext, type ReactNode, useContext } from "react";
import { useWindowDimensions } from "react-native";

const MeasuredWindowWidthContext = createContext<number | null>(null);

export function resolveLayoutWindowWidth(measuredWidth: number | null, dimensionsWidth: number) {
  return measuredWidth !== null && measuredWidth > 0 ? measuredWidth : dimensionsWidth;
}

export function MeasuredWindowWidthProvider({
  width,
  children,
}: {
  width: number | null;
  children: ReactNode;
}) {
  return (
    <MeasuredWindowWidthContext.Provider value={width}>
      {children}
    </MeasuredWindowWidthContext.Provider>
  );
}

/**
 * Width of the rendered root view; RN Dimensions until the first layout.
 * RN Dimensions settles after the root layout during an in-place Android fold.
 * Sizing panes from Dimensions alone made the compact panel gesture fail to
 * attach after folding closed, so pane sizing reads this width instead.
 */
export function useLayoutWindowWidth(): number {
  const measuredWidth = useContext(MeasuredWindowWidthContext);
  const { width: dimensionsWidth } = useWindowDimensions();
  return resolveLayoutWindowWidth(measuredWidth, dimensionsWidth);
}
