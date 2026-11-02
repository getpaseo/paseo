import { requireNativeView } from "expo";
import { useCallback, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type { PaseoTerminalCellMetrics, PaseoTerminalFrame, PaseoTerminalTheme } from "./contract";
import { encodeTerminalCustomGlyphs, type PaseoTerminalCustomGlyph } from "./custom-glyphs";
import { encodeTerminalFrame, type NativePaseoTerminalFrame } from "./frame-encoding";

export * from "./contract";

export interface PaseoTerminalViewProps {
  frame: PaseoTerminalFrame;
  theme: PaseoTerminalTheme;
  fontFamily: string;
  /** Font size in points after the system font scale is applied. */
  fontSize: number;
  onCellMetrics?: (metrics: PaseoTerminalCellMetrics) => void;
  style?: StyleProp<ViewStyle>;
}

interface NativePaseoTerminalViewProps extends Omit<
  PaseoTerminalViewProps,
  "frame" | "onCellMetrics"
> {
  frame: NativePaseoTerminalFrame;
  customGlyphs: PaseoTerminalCustomGlyph[];
  onCellMetrics?: (event: { nativeEvent: PaseoTerminalCellMetrics }) => void;
}

const NativePaseoTerminalView = requireNativeView<NativePaseoTerminalViewProps>("PaseoTerminal");
const CUSTOM_GLYPHS = encodeTerminalCustomGlyphs();

export function PaseoTerminalView({ frame, onCellMetrics, ...props }: PaseoTerminalViewProps) {
  const nativeFrame = useMemo(() => encodeTerminalFrame(frame), [frame]);
  const handleCellMetrics = useCallback(
    (event: { nativeEvent: PaseoTerminalCellMetrics }) => onCellMetrics?.(event.nativeEvent),
    [onCellMetrics],
  );
  return (
    <NativePaseoTerminalView
      {...props}
      frame={nativeFrame}
      customGlyphs={CUSTOM_GLYPHS}
      onCellMetrics={handleCellMetrics}
    />
  );
}
