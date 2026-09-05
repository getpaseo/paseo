import type { ComponentType, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { ViewportFitOptions, ViewportSize } from "./geometry";

export interface ZoomableViewportAction {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  testID?: string;
}

export interface ZoomableViewportProps {
  contentSize: ViewportSize;
  children: ReactNode;
  actions?: ZoomableViewportAction[];
  accessibilityLabel?: string;
  fit?: ViewportFitOptions;
  maxScale?: number;
  minScale?: number;
  onPressOutsideContent?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  wheelActivation?: "always" | "modifier";
}
