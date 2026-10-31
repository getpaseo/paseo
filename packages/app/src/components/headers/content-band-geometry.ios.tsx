import { useCallback } from "react";
import { requireNativeViewManager } from "expo-modules-core";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { supportsModernWindowLayout } from "@/constants/modern-window-layout";
import type {
  ContentBandGeometry,
  ContentBandGeometryProbeProps,
} from "./content-band-geometry.shared";

interface NativeContentBandProps extends ViewProps {
  onGeometryChange: (event: NativeSyntheticEvent<ContentBandGeometry>) => void;
}

const NativeContentBand = supportsModernWindowLayout
  ? requireNativeViewManager<NativeContentBandProps>(
      "PaseoWindowLayout",
      "ContentBandGeometryProbe",
    )
  : null;

export function ContentBandGeometryProbe({
  style,
  onGeometryChange,
}: ContentBandGeometryProbeProps) {
  const handleGeometryChange = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ContentBandGeometry>) => onGeometryChange(nativeEvent),
    [onGeometryChange],
  );
  if (!NativeContentBand) return null;
  return (
    <NativeContentBand style={style} pointerEvents="none" onGeometryChange={handleGeometryChange} />
  );
}
