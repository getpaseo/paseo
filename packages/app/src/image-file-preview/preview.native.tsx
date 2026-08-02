import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image as RNImage,
  StyleSheet as RNStyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { ImageFilePreviewControls } from "./controls";
import {
  FIT_IMAGE_TRANSFORM,
  IMAGE_ZOOM_STEP,
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  type ImagePreviewSize,
  fitImageSize,
  zoomImageAtPoint,
} from "./transform";

interface ImageFilePreviewProps {
  uri: string;
}

export function ImageFilePreview({ uri }: ImageFilePreviewProps) {
  const [viewport, setViewport] = useState<ImagePreviewSize | null>(null);
  const [imageSize, setImageSize] = useState<ImagePreviewSize | null>(null);
  const [controlZoom, setControlZoom] = useState(MIN_IMAGE_ZOOM);
  const zoom = useSharedValue(MIN_IMAGE_ZOOM);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startZoom = useSharedValue(MIN_IMAGE_ZOOM);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pinchStartFocalX = useSharedValue(0);
  const pinchStartFocalY = useSharedValue(0);
  const pinchReady = useSharedValue(false);

  const fittedImage = useMemo(
    () => (imageSize && viewport ? fitImageSize(imageSize, viewport) : null),
    [imageSize, viewport],
  );
  const imageSource = useMemo(() => ({ uri }), [uri]);

  const reset = useCallback(() => {
    zoom.value = FIT_IMAGE_TRANSFORM.zoom;
    translateX.value = FIT_IMAGE_TRANSFORM.x;
    translateY.value = FIT_IMAGE_TRANSFORM.y;
    setControlZoom(MIN_IMAGE_ZOOM);
  }, [translateX, translateY, zoom]);

  useEffect(() => {
    let cancelled = false;
    setImageSize(null);
    reset();
    RNImage.getSize(uri, (width, height) => {
      if (!cancelled) setImageSize({ width, height });
    });
    return () => {
      cancelled = true;
    };
  }, [reset, uri]);

  useEffect(() => {
    reset();
  }, [fittedImage?.height, fittedImage?.width, reset, viewport?.height, viewport?.width]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onBegin(() => {
          startX.value = translateX.value;
          startY.value = translateY.value;
        })
        .onUpdate((event) => {
          if (!fittedImage || !viewport || zoom.value <= MIN_IMAGE_ZOOM) return;
          const maxX = Math.max(0, (fittedImage.width * zoom.value - viewport.width) / 2);
          const maxY = Math.max(0, (fittedImage.height * zoom.value - viewport.height) / 2);
          translateX.value = Math.min(maxX, Math.max(-maxX, startX.value + event.translationX));
          translateY.value = Math.min(maxY, Math.max(-maxY, startY.value + event.translationY));
        }),
    [fittedImage, startX, startY, translateX, translateY, viewport, zoom],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          startZoom.value = zoom.value;
          startX.value = translateX.value;
          startY.value = translateY.value;
          pinchReady.value = false;
        })
        .onUpdate((event) => {
          if (!fittedImage || !viewport) return;
          if (!pinchReady.value) {
            pinchStartFocalX.value = event.focalX;
            pinchStartFocalY.value = event.focalY;
            pinchReady.value = true;
          }

          const nextZoom = Math.min(
            MAX_IMAGE_ZOOM,
            Math.max(MIN_IMAGE_ZOOM, startZoom.value * event.scale),
          );
          if (nextZoom === MIN_IMAGE_ZOOM) {
            zoom.value = MIN_IMAGE_ZOOM;
            translateX.value = 0;
            translateY.value = 0;
            return;
          }

          const centerX = viewport.width / 2;
          const centerY = viewport.height / 2;
          const imagePointX = (pinchStartFocalX.value - centerX - startX.value) / startZoom.value;
          const imagePointY = (pinchStartFocalY.value - centerY - startY.value) / startZoom.value;
          const nextX = event.focalX - centerX - imagePointX * nextZoom;
          const nextY = event.focalY - centerY - imagePointY * nextZoom;
          const maxX = Math.max(0, (fittedImage.width * nextZoom - viewport.width) / 2);
          const maxY = Math.max(0, (fittedImage.height * nextZoom - viewport.height) / 2);

          zoom.value = nextZoom;
          translateX.value = Math.min(maxX, Math.max(-maxX, nextX));
          translateY.value = Math.min(maxY, Math.max(-maxY, nextY));
        })
        .onFinalize(() => {
          runOnJS(setControlZoom)(zoom.value);
        }),
    [
      fittedImage,
      pinchReady,
      pinchStartFocalX,
      pinchStartFocalY,
      startX,
      startY,
      startZoom,
      translateX,
      translateY,
      viewport,
      zoom,
    ],
  );

  const gesture = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture),
    [panGesture, pinchGesture],
  );

  const animatedTranslationStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  const animatedScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: zoom.value }],
  }));

  const zoomFromCenter = useCallback(
    (delta: number) => {
      if (!fittedImage || !viewport) return;
      const nextTransform = zoomImageAtPoint({
        transform: { zoom: zoom.value, x: translateX.value, y: translateY.value },
        zoom: zoom.value + delta,
        focalPoint: { x: viewport.width / 2, y: viewport.height / 2 },
        fittedImage,
        viewport,
      });
      zoom.value = nextTransform.zoom;
      translateX.value = nextTransform.x;
      translateY.value = nextTransform.y;
      setControlZoom(nextTransform.zoom);
    },
    [fittedImage, translateX, translateY, viewport, zoom],
  );

  const layoutChanged = useCallback((event: LayoutChangeEvent) => {
    setViewport({
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    });
  }, []);

  const zoomIn = useCallback(() => {
    zoomFromCenter(IMAGE_ZOOM_STEP);
  }, [zoomFromCenter]);

  const zoomOut = useCallback(() => {
    zoomFromCenter(-IMAGE_ZOOM_STEP);
  }, [zoomFromCenter]);

  const imageFrameStyle = useMemo(
    () => [
      nativeStyles.imageFrame,
      { width: fittedImage?.width ?? 0, height: fittedImage?.height ?? 0 },
      animatedTranslationStyle,
    ],
    [animatedTranslationStyle, fittedImage],
  );

  const renderedImageStyle = useMemo(
    () => [nativeStyles.image, animatedScaleStyle],
    [animatedScaleStyle],
  );

  return (
    <View onLayout={layoutChanged} style={nativeStyles.root} testID="image-file-preview">
      <GestureDetector gesture={gesture}>
        <View style={nativeStyles.canvas} testID="image-file-preview-canvas">
          {fittedImage ? (
            <Animated.View style={imageFrameStyle}>
              <Animated.Image
                resizeMode="contain"
                source={imageSource}
                style={renderedImageStyle}
              />
            </Animated.View>
          ) : (
            <RNImage resizeMode="contain" source={imageSource} style={nativeStyles.loadingImage} />
          )}
        </View>
      </GestureDetector>
      <ImageFilePreviewControls
        zoom={controlZoom}
        onReset={reset}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />
    </View>
  );
}

const nativeStyles = RNStyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  canvas: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  imageFrame: {
    flexShrink: 0,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  loadingImage: {
    width: "100%",
    height: "100%",
  },
});
