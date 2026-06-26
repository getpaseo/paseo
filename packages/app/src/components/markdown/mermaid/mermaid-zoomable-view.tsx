import { useMemo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { MermaidDiagramHost } from "@/components/markdown/mermaid/mermaid-diagram-host";

const MIN_SCALE = 1;
const MAX_SCALE = 4;

type MermaidZoomableMode = "inline" | "fullscreen";

interface MermaidZoomableViewProps {
  svg: string;
  style?: StyleProp<ViewStyle>;
  mode?: MermaidZoomableMode;
}

const zoomStyles = StyleSheet.create({
  fullscreenViewport: {
    width: "100%",
    maxWidth: 960,
    height: "85%",
    maxHeight: "85%",
    minHeight: 120,
    alignSelf: "center",
  },
  viewport: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  animatedLayer: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  hostFill: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  hostIntrinsic: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});

export function MermaidZoomableView({ svg, style, mode = "inline" }: MermaidZoomableViewProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onUpdate((event) => {
          const next = savedScale.value * event.scale;
          scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
        })
        .onEnd(() => {
          savedScale.value = scale.value;
          if (scale.value <= MIN_SCALE) {
            translateX.value = withTiming(0);
            translateY.value = withTiming(0);
            savedTranslateX.value = 0;
            savedTranslateY.value = 0;
          }
        }),
    [savedScale, savedTranslateX, savedTranslateY, scale, translateX, translateY],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          if (scale.value <= MIN_SCALE) {
            return;
          }
          translateX.value = savedTranslateX.value + event.translationX;
          translateY.value = savedTranslateY.value + event.translationY;
        })
        .onEnd(() => {
          savedTranslateX.value = translateX.value;
          savedTranslateY.value = translateY.value;
        }),
    [savedTranslateX, savedTranslateY, scale, translateX, translateY],
  );

  const gesture = useMemo(() => Gesture.Simultaneous(pinch, pan), [pan, pinch]);

  const isFullscreen = mode === "fullscreen";

  const viewportStyle = useMemo(
    () => [isFullscreen ? zoomStyles.fullscreenViewport : null, style, zoomStyles.viewport],
    [isFullscreen, style],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const animatedLayerStyle = useMemo(
    () => [animatedStyle, zoomStyles.animatedLayer],
    [animatedStyle],
  );

  const hostStyle = useMemo(
    () => (isFullscreen ? zoomStyles.hostFill : zoomStyles.hostIntrinsic),
    [isFullscreen],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View style={viewportStyle}>
        <Animated.View style={animatedLayerStyle}>
          <MermaidDiagramHost
            svg={svg}
            layout={isFullscreen ? "fill" : "intrinsic"}
            style={hostStyle}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
