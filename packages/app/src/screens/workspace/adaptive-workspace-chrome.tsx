import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { selectWorkspaceChrome } from "./workspace-tab-layout";
import { WorkspaceTabMeasurementScope } from "./workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import {
  useWorkspaceHeaderWidth,
  type WorkspaceHeaderGeometry,
} from "./use-workspace-header-width";

interface WorkspaceChromeProps {
  compactHeader: ReactNode | null;
  inlineHeader?: ReactNode;
  inlineHeaderActive?: boolean;
  children: ReactNode;
}

/** Split panes choose chrome from their measured allocation. */
export function AdaptiveWorkspaceChrome(props: WorkspaceChromeProps) {
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0) setWidth(measured);
  }, []);
  return <WorkspaceChrome {...props} width={width} onLayout={measure} />;
}

/** Root chrome shares the target allocation with Explorer, including live sidebar resizing. */
export function ProjectedWorkspaceChrome({
  geometry,
  ...props
}: WorkspaceChromeProps & { geometry: WorkspaceHeaderGeometry }) {
  const width = useWorkspaceHeaderWidth(geometry);
  return <WorkspaceChrome {...props} width={width} />;
}

function WorkspaceChrome({
  compactHeader,
  inlineHeader,
  inlineHeaderActive = false,
  children,
  width,
  onLayout,
}: WorkspaceChromeProps & {
  width: number | null;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  let chrome = children;
  if (compactHeader !== null) {
    chrome = inlineHeaderActive
      ? inlineHeader
      : selectWorkspaceChrome({ width, compact: compactHeader, full: children });
  }
  return (
    <WorkspaceTabMeasurementScope>
      <View onLayout={onLayout}>{chrome}</View>
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
