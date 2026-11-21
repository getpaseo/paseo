import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet as RNStyleSheet, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import {
  resolveSidebarResizeHandleGeometry,
  type SidebarResizeEdge,
} from "@/components/sidebar-resize-handle-layout";
import { isWeb } from "@/constants/platform";
import { usePointerCapabilities } from "@/hooks/pointer-capabilities";

interface SidebarResizeHandleProps {
  edge: SidebarResizeEdge;
  gesture: GestureType;
  pressed: SharedValue<boolean>;
  testID: string;
}

const HIGHLIGHT_DELAY_MS = 100;

const webResizeCursorStyle = isWeb
  ? ({
      cursor: "col-resize",
    } as object)
  : null;

function edgeOffsetStyle(edge: SidebarResizeEdge, edgeOffset: number) {
  return edge === "left" ? { left: edgeOffset } : { right: edgeOffset };
}

export function SidebarResizeHandle({ edge, gesture, pressed, testID }: SidebarResizeHandleProps) {
  const { finePointer } = usePointerCapabilities();

  if (finePointer) {
    return <PointerResizeHandle edge={edge} gesture={gesture} pressed={pressed} testID={testID} />;
  }
  return <TouchResizeHandle edge={edge} gesture={gesture} pressed={pressed} testID={testID} />;
}

function PointerResizeHandle({ edge, gesture, testID }: SidebarResizeHandleProps) {
  const [highlighted, setHighlighted] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geometry = resolveSidebarResizeHandleGeometry(true);
  const hitAreaStyle = [
    styles.hitArea,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
    webResizeCursorStyle,
  ];

  const cancelHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current === null) return;
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
  }, []);

  const handleHoverIn = useCallback(() => {
    cancelHighlightTimer();
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlighted(true);
    }, HIGHLIGHT_DELAY_MS);
  }, [cancelHighlightTimer]);

  const handleHoverOut = useCallback(() => {
    cancelHighlightTimer();
    setHighlighted(false);
  }, [cancelHighlightTimer]);

  useEffect(() => cancelHighlightTimer, [cancelHighlightTimer]);

  return (
    <GestureDetector gesture={gesture}>
      <Pressable
        testID={testID}
        style={hitAreaStyle}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
      >
        {highlighted ? (
          <View pointerEvents="none" testID={`${testID}-highlight`} style={styles.highlight} />
        ) : null}
      </Pressable>
    </GestureDetector>
  );
}

function TouchResizeHandle({ edge, gesture, pressed, testID }: SidebarResizeHandleProps) {
  const geometry = resolveSidebarResizeHandleGeometry(false);
  // `box-none` keeps the full-height column out of hit-testing so only the
  // grab target steals taps from the rows behind it.
  const layerStyle = [
    styles.touchLayer,
    { width: geometry.width },
    edgeOffsetStyle(edge, geometry.edgeOffset),
  ];
  const targetStyle = [
    styles.touchTarget,
    { width: geometry.width, height: geometry.height ?? undefined },
  ];
  const gripOpacity = useAnimatedStyle(() => ({ opacity: pressed.value ? 0.3 : 0 }));

  return (
    <View pointerEvents="box-none" style={layerStyle}>
      <GestureDetector gesture={gesture}>
        <View
          testID={testID}
          role="separator"
          aria-orientation="vertical"
          collapsable={false}
          style={targetStyle}
        >
          <Animated.View
            pointerEvents="none"
            style={[edge === "left" ? staticStyles.leftGrip : staticStyles.rightGrip, gripOpacity]}
          >
            <View testID={`${testID}-grip`} style={styles.grip} />
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hitArea: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
  },
  highlight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 5,
    width: 1,
    backgroundColor: theme.colors.foreground,
    opacity: 0.25,
  },
  touchLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  touchTarget: {
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    width: 4,
    height: 36,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
  },
}));

const staticStyles = RNStyleSheet.create({
  leftGrip: { alignSelf: "flex-start", marginLeft: 2 },
  rightGrip: { alignSelf: "flex-end", marginRight: 2 },
});
