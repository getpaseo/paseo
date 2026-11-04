import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { selectWorkspaceChrome } from "./workspace-tab-layout";
import { WorkspaceTabMeasurementScope } from "./workspace-desktop-tabs-row";

export function AdaptiveWorkspaceChrome({
  compactHeader,
  children,
}: {
  compactHeader: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0) setWidth(measured);
  }, []);
  return (
    <WorkspaceTabMeasurementScope>
      <View onLayout={measure}>
        {selectWorkspaceChrome({ width, compact: compactHeader, full: children })}
      </View>
    </WorkspaceTabMeasurementScope>
  );
}

export interface WorkspaceCompactHeaderActions {
  pane?: {
    id: string;
    splitRight?: () => void;
    splitDown?: () => void;
    toggleMaximized?: () => void;
    maximized: boolean;
  };
  closeAbove: (key: string) => Promise<void> | void;
  closeBelow: (key: string) => Promise<void> | void;
  closeOthers: (key: string) => Promise<void> | void;
}
