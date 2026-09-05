import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { KeyboardTranslateView } from "@/components/keyboard-translate-view";

interface KeyboardDockProps extends ViewProps {
  children: ReactNode;
}

export function KeyboardDock({ children, style, ...props }: KeyboardDockProps) {
  return (
    <KeyboardTranslateView style={style} {...props}>
      {children}
    </KeyboardTranslateView>
  );
}
