import { useCallback, useMemo, useState } from "react";
import { Image, type ImageLoadEventData } from "expo-image";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ViewportFitOptions, ViewportSize } from "./geometry";
import { ZoomableViewport } from "./index";
import type { ZoomableViewportAction } from "./types";

const ViewportImage = withUnistyles(Image);

interface ZoomableImageProps {
  uri: string;
  accessibilityLabel?: string;
  actions?: ZoomableViewportAction[];
  contentSize?: ViewportSize;
  fit?: ViewportFitOptions;
  maxScale?: number;
  minScale?: number;
  onError?: () => void;
  onPressOutsideContent?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  wheelActivation?: "always" | "modifier";
}

export function ZoomableImage({
  uri,
  accessibilityLabel,
  actions,
  contentSize,
  fit,
  maxScale,
  minScale = 1,
  onError,
  onPressOutsideContent,
  style,
  testID = "zoomable-image",
  wheelActivation = "always",
}: ZoomableImageProps) {
  const [loadedImage, setLoadedImage] = useState<{ uri: string; size: ViewportSize } | null>(null);
  const resolvedSize = contentSize ?? (loadedImage?.uri === uri ? loadedImage.size : null);
  const source = useMemo(() => ({ uri }), [uri]);
  const handleLoad = useCallback(
    ({ source: { width, height } }: ImageLoadEventData) => {
      if (width > 0 && height > 0) setLoadedImage({ uri, size: { width, height } });
    },
    [uri],
  );

  if (!resolvedSize) {
    return (
      <View style={[styles.root, style]} testID={testID}>
        <ViewportImage
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="image"
          onError={onError}
          onLoad={handleLoad}
          contentFit="contain"
          source={source}
          style={styles.image}
          testID={`${testID}-image`}
        />
      </View>
    );
  }

  return (
    <ZoomableViewport
      accessibilityLabel={accessibilityLabel}
      actions={actions}
      contentSize={resolvedSize}
      fit={fit}
      maxScale={maxScale}
      minScale={minScale}
      onPressOutsideContent={onPressOutsideContent}
      style={style}
      testID={testID}
      wheelActivation={wheelActivation}
    >
      <ViewportImage
        onError={onError}
        contentFit="contain"
        source={source}
        style={styles.image}
        testID={`${testID}-image`}
      />
    </ZoomableViewport>
  );
}

const styles = StyleSheet.create(() => ({
  root: { flex: 1, minHeight: 0 },
  image: { width: "100%", height: "100%" },
}));
