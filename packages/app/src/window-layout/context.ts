import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import type { WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useWindowDimensions();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}
