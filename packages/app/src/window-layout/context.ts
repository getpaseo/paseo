import { createContext, useContext } from "react";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import type { TopBand, WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);

/** Published by `WindowLayoutProvider` beside the safe-area insets it derives from it. */
export const TopBandContext = createContext<TopBand | null>(null);

export const WindowLayoutContentAllocationContext = createContext<{
  workspaceKey: string | null;
  explorerVisible: boolean;
  // A docked navigation sidebar owns live resize geometry through flex layout.
  width: number | null;
  targetWidth: number;
  leftDockWidth: number;
} | null>(null);

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useAppWindowSize();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}

/** The top band beside the system's status region, or null where the window has none. */
export function useTopBand(): TopBand | null {
  return useContext(TopBandContext);
}
