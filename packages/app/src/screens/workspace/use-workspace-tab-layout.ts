import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutMetrics,
  type WorkspaceTabLayoutResult,
  type WorkspaceTabPriority,
} from "@/screens/workspace/workspace-tab-layout";

interface UseWorkspaceTabLayoutInput {
  activeTab: WorkspaceTabPriority | null;
  tabLabelWidths: number[];
  viewportWidthOverride?: number | null;
  metrics: WorkspaceTabLayoutMetrics;
  compact: boolean;
}

interface UseWorkspaceTabLayoutResult {
  layout: WorkspaceTabLayoutResult;
}

export function useWorkspaceTabLayout(
  input: UseWorkspaceTabLayoutInput,
): UseWorkspaceTabLayoutResult {
  const { width: viewportWidth } = useWindowDimensions();
  const resolvedViewportWidth =
    typeof input.viewportWidthOverride === "number" && input.viewportWidthOverride > 0
      ? input.viewportWidthOverride
      : viewportWidth;

  const layout = useMemo(
    () =>
      computeWorkspaceTabLayout({
        activeTab: input.activeTab,
        viewportWidth: resolvedViewportWidth,
        tabLabelWidths: input.tabLabelWidths,
        metrics: input.metrics,
        compact: input.compact,
      }),
    [input.activeTab, input.compact, input.metrics, input.tabLabelWidths, resolvedViewportWidth],
  );

  return {
    layout,
  };
}
