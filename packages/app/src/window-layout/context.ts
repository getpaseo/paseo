import { createContext, useContext } from "react";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import type { WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useAppWindowSize();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}
