import { useCallback, useId, useState } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

type EdgeFadeBackdrop = "surface0" | "surfaceWorkspace" | "surface3";

const backdropColorMappings: Record<EdgeFadeBackdrop, (theme: Theme) => { color: string }> = {
  surface3: (theme) => ({ color: theme.colors.surface3 }),
  surface0: (theme) => ({ color: theme.colors.surface0 }),
  surfaceWorkspace: (theme) => ({ color: theme.colors.surfaceWorkspace }),
};

interface EdgeFadeSvgProps {
  width: number;
  height: number;
  gradientId: string;
  color: string;
  edge: "top" | "bottom";
  solidFraction: number;
}

function EdgeFadeSvg({ width, height, gradientId, color, edge, solidFraction }: EdgeFadeSvgProps) {
  const fromTop = edge === "top";
  return (
    <Svg width={width} height={height} preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient
          id={gradientId}
          x1="0%"
          y1={fromTop ? "0%" : "100%"}
          x2="0%"
          y2={fromTop ? "100%" : "0%"}
        >
          {/* Vary opacity rather than interpolating toward `transparent`, which crosses black in
              some engines and leaves a grey fringe. Keep it to three stops: Android rendered a
              four-stop version far more transparent than its stops specify. */}
          <Stop offset={0} stopColor={color} stopOpacity={1} />
          <Stop offset={solidFraction} stopColor={color} stopOpacity={1} />
          <Stop offset={1} stopColor={color} stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedEdgeFadeSvg = withUnistyles(EdgeFadeSvg);

interface EdgeFadeProps {
  /** The solid edge; content dissolves moving away from it. */
  edge: "top" | "bottom";
  /** Share of the fade, measured from the solid edge, that stays fully opaque. */
  solidFraction: number;
  backdrop: EdgeFadeBackdrop;
  /** Position and size. Keep the fade inside its parent: Android clips overhanging children. */
  style: StyleProp<ViewStyle>;
}

/** Dissolves content into the surface behind chrome that floats over it. */
export function EdgeFade({ edge, solidFraction, backdrop, style }: EdgeFadeProps) {
  // React-generated ids contain characters that are invalid inside SVG fragment references.
  const gradientId = `edge-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Sized in points from layout: with percent sizes the fade stopped covering the header on iOS
  // after the window reflowed (a folded iPhone's vertical bar turning off).
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  return (
    <View style={style} pointerEvents="none" onLayout={handleLayout}>
      {size ? (
        <ThemedEdgeFadeSvg
          width={size.width}
          height={size.height}
          gradientId={gradientId}
          edge={edge}
          solidFraction={solidFraction}
          uniProps={backdropColorMappings[backdrop]}
        />
      ) : null}
    </View>
  );
}
