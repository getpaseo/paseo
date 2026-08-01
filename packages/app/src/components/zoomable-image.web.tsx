import { useMemo } from "react";
import { Pressable } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { ZoomableImageProps } from "./zoomable-image.types";

export function ZoomableImage({
  uri,
  accessibilityLabel,
  onError,
  onLongPress,
  testID,
}: ZoomableImageProps) {
  const source = useMemo(() => ({ uri }), [uri]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onLongPress={onLongPress}
      style={viewportStyle}
    >
      <ExpoImage
        testID={testID}
        source={source}
        contentFit="contain"
        onError={onError}
        style={imageFillStyle}
      />
    </Pressable>
  );
}

const viewportStyle = {
  flex: 1,
  width: "100%",
} as const;

const imageFillStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;
