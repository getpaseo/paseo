import { useCallback, useId, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

/** How far the fade runs past the header's bottom edge, so content dissolves instead of clipping. */
const FADE_OVERHANG = 24;

interface FloatingHeaderLayoutProps {
  header: ReactNode;
  /** Float only when the content supports visual-top clearance. */
  floating: boolean;
  children: (topOverlayInset: number) => ReactNode;
}

/**
 * Stacks a header above content, or floats it over the content behind a fade. Children keep the
 * same tree position in both modes, so toggling `floating` never remounts them.
 */
export function FloatingHeaderLayout({ header, floating, children }: FloatingHeaderLayoutProps) {
  const [headerHeight, setHeaderHeight] = useState(0);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  return (
    <View style={styles.root}>
      {floating ? null : header}
      <View style={styles.content}>{children(floating ? headerHeight : 0)}</View>
      {floating ? (
        <View style={styles.overlay} pointerEvents="box-none" onLayout={handleHeaderLayout}>
          <FloatingHeaderFade />
          {header}
        </View>
      ) : null}
    </View>
  );
}

function FloatingHeaderFadeSvg({ gradientId, color }: { gradientId: string; color: string }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          {/* Vary opacity rather than interpolating toward `transparent`, which crosses black in
              some engines and leaves a grey fringe. */}
          <Stop offset="0%" stopColor={color} stopOpacity={1} />
          <Stop offset="50%" stopColor={color} stopOpacity={0.97} />
          <Stop offset="75%" stopColor={color} stopOpacity={0.8} />
          <Stop offset="100%" stopColor={color} stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedFloatingHeaderFadeSvg = withUnistyles(FloatingHeaderFadeSvg);
const workspaceSurfaceColorMapping = (theme: Theme) => ({
  color: theme.colors.surfaceWorkspace,
});

function FloatingHeaderFade() {
  // React-generated ids contain characters that are invalid inside SVG fragment references.
  const gradientId = `floating-header-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <View style={styles.fade} pointerEvents="none">
      <ThemedFloatingHeaderFadeSvg
        gradientId={gradientId}
        uniProps={workspaceSurfaceColorMapping}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: -FADE_OVERHANG,
  },
});
