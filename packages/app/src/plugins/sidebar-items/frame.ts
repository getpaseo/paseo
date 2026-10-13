import { createContext, useContext } from "react";
import type { View } from "react-native";
import type { PluginSidebarSection } from "../types";

/** What the host tells the kit components about the sidebar item they render in. */
export interface SidebarItemFrame {
  section: PluginSidebarSection;
  title: string;
  testID: string;
  /** A row calls this before its `onPress`, so a popover that press opens anchors to it. */
  anchorTo: (node: View | null) => void;
  /** Rows offer themselves on mount, so a popover opened without a press anchors to a row. */
  offerAnchor: (node: View | null) => void;
  releaseAnchor: (node: View | null) => void;
}

export const SidebarItemFrameContext = createContext<SidebarItemFrame | null>(null);

export function useSidebarItemFrame(componentName: string): SidebarItemFrame {
  const frame = useContext(SidebarItemFrameContext);
  if (!frame) throw new Error(`${componentName} must render inside a sidebar item`);
  return frame;
}
