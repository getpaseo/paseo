import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ViewportFitOptions, ViewportSize } from "./geometry";
import { ZoomableViewport } from "./index";
import type { ZoomableViewportAction } from "./types";

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
  const [loaded, setLoaded] = useState<{ uri: string; size: ViewportSize } | null>(null);
  const resolvedSize = contentSize ?? (loaded?.uri === uri ? loaded.size : null);
  const source = useMemo(() => ({ uri }), [uri]);
  const [paintedUri, setPaintedUri] = useState<string | null>(null);
  const handleLoad = useCallback(() => setPaintedUri(uri), [uri]);

  useEffect(() => {
    if (contentSize) return;
    let active = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (active && width > 0 && height > 0) setLoaded({ uri, size: { width, height } });
      },
      () => {
        if (active) onError?.();
      },
    );
    return () => {
      active = false;
    };
  }, [contentSize, onError, uri]);

  // Paint nothing until the image can be fitted: an unfitted image fills the whole area for the
  // frames before the size arrives, then jumps to its fitted box. Then keep the viewport, toolbar
  // included, hidden until the image itself has loaded, so they appear together.
  if (!resolvedSize) {
    return <View style={[styles.root, style]} testID={testID} />;
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
      style={[style, paintedUri !== uri && styles.loading]}
      testID={testID}
      wheelActivation={wheelActivation}
    >
      <Image
        // Android fades a freshly decoded image in over 300ms; it appears with its toolbar instead.
        fadeDuration={0}
        onError={onError}
        onLoad={handleLoad}
        resizeMode="contain"
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
  loading: { opacity: 0 },
}));
