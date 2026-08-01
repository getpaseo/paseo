import { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Image as ExpoImage, type ImageLoadEventData } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import type { ZoomableImageProps } from "./zoomable-image.types";
import { getContainedPanBounds, getFocalTranslation } from "./zoomable-image-geometry";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2;

function clamp(value: number, minimum: number, maximum: number): number {
  "worklet";
  return Math.min(Math.max(value, minimum), maximum);
}

export function ZoomableImage({
  uri,
  accessibilityLabel,
  onError,
  onLongPress,
  testID,
}: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const initialScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const initialTranslateX = useSharedValue(0);
  const initialTranslateY = useSharedValue(0);
  const initialFocalX = useSharedValue(0);
  const initialFocalY = useSharedValue(0);
  const viewportWidth = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const imageWidth = useSharedValue(0);
  const imageHeight = useSharedValue(0);
  const activeImageGeneration = useSharedValue(0);
  const imageGenerationRef = useRef({ uri, generation: 1 });
  if (imageGenerationRef.current.uri !== uri) {
    imageGenerationRef.current = {
      uri,
      generation: imageGenerationRef.current.generation + 1,
    };
  }
  const imageGeneration = imageGenerationRef.current.generation;

  const gesture = useMemo(() => {
    function resetZoom() {
      "worklet";
      scale.value = withTiming(1);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
    }

    function clampTranslation() {
      "worklet";
      const bounds = getContainedPanBounds({
        viewportWidth: viewportWidth.value,
        viewportHeight: viewportHeight.value,
        imageWidth: imageWidth.value,
        imageHeight: imageHeight.value,
        scale: scale.value,
      });
      translateX.value = withTiming(clamp(translateX.value, -bounds.x, bounds.x));
      translateY.value = withTiming(clamp(translateY.value, -bounds.y, bounds.y));
    }

    const pinch = Gesture.Pinch()
      .onStart((event) => {
        initialScale.value = scale.value;
        initialFocalX.value = event.focalX - viewportWidth.value / 2;
        initialFocalY.value = event.focalY - viewportHeight.value / 2;
        initialTranslateX.value = translateX.value;
        initialTranslateY.value = translateY.value;
      })
      .onUpdate((event) => {
        const nextScale = clamp(initialScale.value * event.scale, 1, MAX_SCALE);
        const scaleRatio = nextScale / initialScale.value;
        const focalX = event.focalX - viewportWidth.value / 2;
        const focalY = event.focalY - viewportHeight.value / 2;
        const bounds = getContainedPanBounds({
          viewportWidth: viewportWidth.value,
          viewportHeight: viewportHeight.value,
          imageWidth: imageWidth.value,
          imageHeight: imageHeight.value,
          scale: nextScale,
        });
        const nextTranslateX = getFocalTranslation({
          startTranslation: initialTranslateX.value,
          startFocal: initialFocalX.value,
          focal: focalX,
          scaleRatio,
        });
        const nextTranslateY = getFocalTranslation({
          startTranslation: initialTranslateY.value,
          startFocal: initialFocalY.value,
          focal: focalY,
          scaleRatio,
        });
        scale.value = nextScale;
        translateX.value = clamp(nextTranslateX, -bounds.x, bounds.x);
        translateY.value = clamp(nextTranslateY, -bounds.y, bounds.y);
      })
      .onEnd(() => {
        if (scale.value <= 1) {
          resetZoom();
          return;
        }
        clampTranslation();
      });

    const pan = Gesture.Pan()
      .minPointers(1)
      .maxPointers(2)
      .onChange((event) => {
        if (event.numberOfPointers !== 1 || scale.value <= 1) {
          return;
        }
        const bounds = getContainedPanBounds({
          viewportWidth: viewportWidth.value,
          viewportHeight: viewportHeight.value,
          imageWidth: imageWidth.value,
          imageHeight: imageHeight.value,
          scale: scale.value,
        });
        translateX.value = clamp(translateX.value + event.changeX, -bounds.x, bounds.x);
        translateY.value = clamp(translateY.value + event.changeY, -bounds.y, bounds.y);
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(250)
      .onEnd((event, succeeded) => {
        if (!succeeded) {
          return;
        }
        if (scale.value > 1) {
          resetZoom();
          return;
        }
        const focalX = event.x - viewportWidth.value / 2;
        const focalY = event.y - viewportHeight.value / 2;
        const bounds = getContainedPanBounds({
          viewportWidth: viewportWidth.value,
          viewportHeight: viewportHeight.value,
          imageWidth: imageWidth.value,
          imageHeight: imageHeight.value,
          scale: DOUBLE_TAP_SCALE,
        });
        const scaleRatio = DOUBLE_TAP_SCALE / scale.value;
        const nextTranslateX = getFocalTranslation({
          startTranslation: translateX.value,
          startFocal: focalX,
          focal: focalX,
          scaleRatio,
        });
        const nextTranslateY = getFocalTranslation({
          startTranslation: translateY.value,
          startFocal: focalY,
          focal: focalY,
          scaleRatio,
        });
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        translateX.value = withTiming(clamp(nextTranslateX, -bounds.x, bounds.x));
        translateY.value = withTiming(clamp(nextTranslateY, -bounds.y, bounds.y));
      });

    const longPress = Gesture.LongPress()
      .minDuration(500)
      .onStart(() => {
        if (onLongPress) {
          runOnJS(onLongPress)();
        }
      });

    return Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, longPress));
  }, [
    initialScale,
    initialFocalX,
    initialFocalY,
    initialTranslateX,
    initialTranslateY,
    imageHeight,
    imageWidth,
    onLongPress,
    scale,
    translateX,
    translateY,
    viewportHeight,
    viewportWidth,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));
  const source = useMemo(() => ({ uri }), [uri]);

  const updateViewportSize = useCallback(
    (width: number, height: number) => {
      "worklet";
      viewportWidth.value = width;
      viewportHeight.value = height;
      const bounds = getContainedPanBounds({
        viewportWidth: width,
        viewportHeight: height,
        imageWidth: imageWidth.value,
        imageHeight: imageHeight.value,
        scale: scale.value,
      });
      translateX.value = clamp(translateX.value, -bounds.x, bounds.x);
      translateY.value = clamp(translateY.value, -bounds.y, bounds.y);
    },
    [imageHeight, imageWidth, scale, translateX, translateY, viewportHeight, viewportWidth],
  );
  const updateImageSize = useCallback(
    (generation: number, width: number, height: number) => {
      "worklet";
      if (generation < activeImageGeneration.value) {
        return;
      }
      activeImageGeneration.value = generation;
      scale.value = 1;
      initialScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      initialTranslateX.value = 0;
      initialTranslateY.value = 0;
      initialFocalX.value = 0;
      initialFocalY.value = 0;
      imageWidth.value = width;
      imageHeight.value = height;
    },
    [
      activeImageGeneration,
      imageHeight,
      imageWidth,
      initialFocalX,
      initialFocalY,
      initialScale,
      initialTranslateX,
      initialTranslateY,
      scale,
      translateX,
      translateY,
    ],
  );
  const resetImageState = useCallback(
    (generation: number) => {
      "worklet";
      if (generation <= activeImageGeneration.value) {
        return;
      }
      activeImageGeneration.value = generation;
      scale.value = 1;
      initialScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      initialTranslateX.value = 0;
      initialTranslateY.value = 0;
      initialFocalX.value = 0;
      initialFocalY.value = 0;
      imageWidth.value = 0;
      imageHeight.value = 0;
    },
    [
      activeImageGeneration,
      imageHeight,
      imageWidth,
      initialFocalX,
      initialFocalY,
      initialScale,
      initialTranslateX,
      initialTranslateY,
      scale,
      translateX,
      translateY,
    ],
  );
  useEffect(() => {
    scheduleOnUI(resetImageState, imageGeneration);
  }, [imageGeneration, resetImageState]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      scheduleOnUI(
        updateViewportSize,
        event.nativeEvent.layout.width,
        event.nativeEvent.layout.height,
      );
    },
    [updateViewportSize],
  );
  const handleImageLoad = useCallback(
    (event: ImageLoadEventData) => {
      scheduleOnUI(updateImageSize, imageGeneration, event.source.width, event.source.height);
    },
    [imageGeneration, updateImageSize],
  );

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="imagebutton"
        accessibilityLabel={accessibilityLabel}
        onLayout={handleLayout}
        style={styles.viewport}
      >
        <Animated.View style={[styles.imageLayer, animatedStyle]}>
          <ExpoImage
            key={uri}
            testID={testID}
            source={source}
            contentFit="contain"
            onLoad={handleImageLoad}
            onError={onError}
            style={styles.image}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
    width: "100%",
    overflow: "hidden",
  },
  imageLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
});
