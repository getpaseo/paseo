import { createContext, useContext, useCallback, useState, useId, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Portal, PortalHost } from "@gorhom/portal";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { EdgeFade } from "@/components/ui/edge-fade";

const OverlayClearanceContext = createContext(0);
const OverlayHostContext = createContext<string | null>(null);

/** Keep status overlays above the fade without lifting the scrolling content. */
export function FloatingHeaderOverlay({ children }: { children: ReactNode }) {
  const hostName = useContext(OverlayHostContext);
  const active = useRetainedPanelActive();
  if (!hostName) return children;
  return active ? <Portal hostName={hostName}>{children}</Portal> : null;
}

/** Clearance for stationary overlays inside this layout, measured to the header bottom. */
export function useFloatingHeaderOverlayClearance(): number {
  return useContext(OverlayClearanceContext);
}

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
  const overlayHostName = useId();
  const [headerHeight, setHeaderHeight] = useState(0);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  const overlayClearance = floating ? headerHeight : 0;

  return (
    <View style={styles.root}>
      {floating ? null : header}
      <View style={styles.content}>
        <OverlayClearanceContext.Provider value={overlayClearance}>
          <OverlayHostContext.Provider value={floating ? overlayHostName : null}>
            {children(floating ? headerHeight : 0)}
          </OverlayHostContext.Provider>
        </OverlayClearanceContext.Provider>
      </View>
      {floating ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <EdgeFade
            edge="top"
            solidFraction={FADE_SOLID_FRACTION}
            backdrop="surfaceWorkspace"
            style={styles.fade}
          />
          <View
            testID="floating-header"
            collapsable={false}
            pointerEvents="box-none"
            onLayout={handleHeaderLayout}
          >
            {header}
          </View>
        </View>
      ) : null}
      <View style={styles.statusOverlay} pointerEvents="box-none">
        <PortalHost name={overlayHostName} />
      </View>
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
  statusOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
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
