import type { ComponentProps, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { MobilePanelOverlay } from "@/mobile-panels/presentation";
export interface ExplorerGeometryInput {
  width: number;
  containerWidth: number;
  overlay: boolean;
  resizeEnabled: boolean;
  onResize: (width: number) => void;
}
export interface ExplorerGeometry {
  frameStyle: ComponentProps<typeof MobilePanelOverlay>["frameStyle"];
  panelStyle: StyleProp<ViewStyle>;
  resizeHandle: ReactNode;
}
