import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { useSidebarResizeGate } from "@/components/sidebar-resize-activity";
import { retainWorkspaceChromeWidth, selectWorkspaceChrome } from "./workspace-tab-layout";
import { WorkspaceTabMeasurementScope } from "./workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

/**
 * Shows `children` (full header and tab rail) or `compactHeader` below the compact width.
 * Without a compact header it always shows `children`, keeping the same tree so they never remount.
 */
export function AdaptiveWorkspaceChrome({
  compactHeader,
  children,
}: {
  compactHeader: ReactNode | null;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number | null>(null);
  // Only the compact decision reads the width; keeping it until that flips stops a sidebar drag
  // from re-rendering the header and tab rail on every layout pass. A drag across the threshold
  // switches the chrome once, where it ends.
  const applyWidth = useCallback((measured: number) => {
    setWidth((current) => retainWorkspaceChromeWidth(current, measured));
  }, []);
  const offerWidth = useSidebarResizeGate(applyWidth);
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.width;
      // The first width always lands, so the chrome never waits for a drag to end to appear.
      setWidth((current) =>
        current === null ? retainWorkspaceChromeWidth(null, measured) : current,
      );
      offerWidth(measured);
    },
    [offerWidth],
  );
  return (
    <WorkspaceTabMeasurementScope>
      <View onLayout={measure}>
        {compactHeader === null
          ? children
          : selectWorkspaceChrome({ width, compact: compactHeader, full: children })}
      </View>
    </WorkspaceTabMeasurementScope>
  );
}

/** One pane's tabs, as its compact tab switcher and pane menu need them. */
export interface WorkspaceCompactHeaderTabs {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  actions: WorkspaceCompactHeaderActions;
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
