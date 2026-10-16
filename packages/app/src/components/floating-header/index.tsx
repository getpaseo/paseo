import { useCallback, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { EdgeFade } from "@/components/ui/edge-fade";

/** How far the fade runs past the header's bottom edge, so content dissolves instead of clipping. */
const FADE_OVERHANG = 48;
/** Share of the fade that stays opaque, so the header's title and icons keep contrast. */
const FADE_SOLID_FRACTION = 0.57;

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
        <View style={styles.overlay} pointerEvents="box-none">
          <EdgeFade
            edge="top"
            solidFraction={FADE_SOLID_FRACTION}
            backdrop="surfaceWorkspace"
            style={styles.fade}
          />
          <View pointerEvents="box-none" onLayout={handleHeaderLayout}>
            {header}
          </View>
        </View>
      ) : null}
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
    // The fade's tail lives inside the overlay so Android does not clip it.
    paddingBottom: FADE_OVERHANG,
  },
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
