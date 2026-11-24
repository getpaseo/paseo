import { useMemo } from "react";
import { useWindowMetric } from "@/hooks/use-window-metric";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutMetrics,
  type WorkspaceTabLayoutResult,
} from "@/screens/workspace/workspace-tab-layout";

interface UseWorkspaceTabLayoutInput {
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
  const override = input.viewportWidthOverride;
  const resolvedViewportWidth = useWindowMetric(({ width }) =>
    typeof override === "number" && override > 0 ? override : width,
  );

  const layout = useMemo(
    () =>
      computeWorkspaceTabLayout({
        viewportWidth: resolvedViewportWidth,
        tabLabelWidths: input.tabLabelWidths,
        metrics: input.metrics,
        compact: input.compact,
      }),
    [input.compact, input.metrics, input.tabLabelWidths, resolvedViewportWidth],
  );

  return {
    layout,
  };
}
