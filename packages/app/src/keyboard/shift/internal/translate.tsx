import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  bottomClearance?: number;
}

export function KeyboardTranslateView({
  children,
  enabled: _enabled,
  bottomClearance: _bottomClearance,
  ...props
}: KeyboardTranslateViewProps) {
  return <View {...props}>{children}</View>;
}
