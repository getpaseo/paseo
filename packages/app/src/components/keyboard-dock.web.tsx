import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";

interface KeyboardDockProps extends ViewProps {
  children: ReactNode;
}

export function KeyboardDock(props: KeyboardDockProps) {
  return <View {...props} />;
}
