import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
}

export function KeyboardTranslateView({
  children,
  enabled: _enabled,
  ...props
}: KeyboardTranslateViewProps) {
  return <View {...props}>{children}</View>;
}
