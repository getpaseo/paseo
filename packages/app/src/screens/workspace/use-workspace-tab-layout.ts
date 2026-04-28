import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutResult,
} from "@/screens/workspace/workspace-tab-layout";

type UseWorkspaceTabLayoutInput = {
  tabLabelLengths: number[];
  viewportWidthOverride?: number | null;
  metrics: {
    rowHorizontalInset: number;
    actionsReservedWidth: number;
    rowPaddingHorizontal: number;
    tabGap: number;
    maxTabWidth: number;
    tabIconWidth: number;
    tabHorizontalPadding: number;
    estimatedCharWidth: number;
    closeButtonWidth: number;
  };
};

type UseWorkspaceTabLayoutResult = {
  layout: WorkspaceTabLayoutResult;
};

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
        viewportWidth: resolvedViewportWidth,
        tabLabelLengths: input.tabLabelLengths,
        metrics: input.metrics,
      }),
    [input.metrics, input.tabLabelLengths, resolvedViewportWidth],
  );

  return {
    layout,
  };
}
