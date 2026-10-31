import { useCallback, useMemo, useRef, useState } from "react";
import {
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ITheme } from "@xterm/xterm";

import {
  PaseoTerminalView,
  type PaseoTerminalCellMetrics,
  type PaseoTerminalTheme,
} from "../../../modules/paseo-terminal";
import {
  createTerminalCellStyleResolver,
  DEFAULT_TERMINAL_THEME,
  NATIVE_TERMINAL_SELECTION_COLORS,
} from "./colors";
import { resolveNativeTerminalFontFamily } from "./font.native";
import type { TerminalViewportState } from "./headless-terminal-state";
import {
  resolveTerminalGridMetricsMeasurement,
  type TerminalGridCellMetrics,
} from "./terminal-grid-metrics";
import { buildTerminalFrame } from "./terminal-frame";
import type { TerminalSelectionRange } from "./terminal-selection";

const DEFAULT_FONT_SIZE = 12;

export interface TerminalGridViewProps {
  state: TerminalViewportState;
  xtermTheme?: ITheme;
  fontFamily?: string;
  fontSize?: number;
  style?: StyleProp<ViewStyle>;
  selection?: TerminalSelectionRange | null;
  onCellMetricsChange?: (metrics: TerminalGridCellMetrics) => void;
}

function resolveVisibleCols(input: {
  viewportWidth: number | null;
  cellWidth: number | null;
  gridCols: number;
}): number {
  if (input.viewportWidth === null || input.cellWidth === null) {
    return input.gridCols;
  }
  if (input.viewportWidth <= 0 || input.cellWidth <= 0 || input.gridCols <= 0) {
    return 0;
  }
  return Math.min(input.gridCols, Math.max(1, Math.floor(input.viewportWidth / input.cellWidth)));
}

export function TerminalGridView({
  state,
  xtermTheme = DEFAULT_TERMINAL_THEME,
  fontFamily,
  fontSize = DEFAULT_FONT_SIZE,
  style,
  selection = null,
  onCellMetricsChange,
}: TerminalGridViewProps) {
  const { fontScale } = useWindowDimensions();
  const [cellWidth, setCellWidth] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const measuredMetricsRef = useRef<TerminalGridCellMetrics | null>(null);
  const resolvedFontFamily = useMemo(
    () => resolveNativeTerminalFontFamily(fontFamily),
    [fontFamily],
  );
  const resolver = useMemo(() => createTerminalCellStyleResolver(xtermTheme), [xtermTheme]);
  const theme = useMemo<PaseoTerminalTheme>(
    () => ({
      background: resolver.backgroundColor,
      cursor: resolver.cursorColor,
      selectionBackground: NATIVE_TERMINAL_SELECTION_COLORS.background,
      selectionForeground: NATIVE_TERMINAL_SELECTION_COLORS.foreground,
    }),
    [resolver],
  );
  const columns = resolveVisibleCols({ viewportWidth, cellWidth, gridCols: state.cols });
  const frame = useMemo(
    () => buildTerminalFrame({ state, columns, resolver, selection }),
    [columns, resolver, selection, state],
  );

  const handleCellMetrics = useCallback(
    (metrics: PaseoTerminalCellMetrics) => {
      const changedMetrics = resolveTerminalGridMetricsMeasurement(
        measuredMetricsRef.current,
        metrics,
      );
      if (!changedMetrics) {
        return;
      }
      measuredMetricsRef.current = changedMetrics;
      setCellWidth(changedMetrics.cellWidth);
      onCellMetricsChange?.(changedMetrics);
    },
    [onCellMetricsChange],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setViewportWidth((current) => (current === width ? current : width));
  }, []);

  return (
    <View onLayout={handleContainerLayout} pointerEvents="none" style={[styles.root, style]}>
      <PaseoTerminalView
        frame={frame}
        theme={theme}
        fontFamily={resolvedFontFamily}
        fontSize={fontSize * fontScale}
        onCellMetrics={handleCellMetrics}
        style={styles.surface}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: "hidden",
  },
  surface: {
    flex: 1,
  },
});
