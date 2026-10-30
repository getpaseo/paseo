import { useCallback } from "react";
import { requireNativeViewManager } from "expo-modules-core";
import { StyleSheet, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { supportsModernWindowLayout } from "@/constants/modern-window-layout";
import type { BottomBarGeometry, BottomBarGeometryProbeProps } from "./bottom-bar-geometry.shared";
export type { BottomBarGeometry, BottomBarGeometryProbeProps } from "./bottom-bar-geometry.shared";

interface NativeBottomBarProbeProps extends ViewProps {
  extent: number;
  adaptHorizontalEdges: boolean;
  onGeometryChange: (event: NativeSyntheticEvent<BottomBarGeometry>) => void;
}

const NativeBottomBarProbe = supportsModernWindowLayout
  ? requireNativeViewManager<NativeBottomBarProbeProps>(
      "PaseoWindowLayout",
      "BottomBarGeometryProbe",
    )
  : null;

export function BottomBarGeometryProbe({
  extent,
  adaptHorizontalEdges = false,
  onGeometryChange,
}: BottomBarGeometryProbeProps) {
  const handleGeometryChange = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<BottomBarGeometry>) => {
      onGeometryChange(nativeEvent);
    },
    [onGeometryChange],
  );

  if (!NativeBottomBarProbe) return null;

  return (
    <NativeBottomBarProbe
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      extent={extent}
      adaptHorizontalEdges={adaptHorizontalEdges}
      onGeometryChange={handleGeometryChange}
    />
  );
}
