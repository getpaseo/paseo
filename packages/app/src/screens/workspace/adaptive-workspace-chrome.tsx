import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { useSidebarResizeGate } from "@/components/sidebar-resize-activity";
import { shouldUseCompactWorkspaceHeader } from "./workspace-tab-layout";
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
  const [compact, setCompact] = useState(false);
  // Switching between the full and compact header swaps the whole chrome. A sidebar drag across
  // the threshold switches it once, where the drag ends.
  const offerCompact = useSidebarResizeGate(setCompact);
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.width;
      if (measured > 0) offerCompact(shouldUseCompactWorkspaceHeader(measured));
    },
    [offerCompact],
  );
  return (
    <WorkspaceTabMeasurementScope>
      <View onLayout={measure}>{compactHeader !== null && compact ? compactHeader : children}</View>
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
