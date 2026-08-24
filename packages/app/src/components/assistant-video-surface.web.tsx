import { useCallback, type SyntheticEvent } from "react";
import { View } from "react-native";
import type { AssistantVideoSurfaceProps } from "@/components/assistant-video-surface";

const videoStyle = {
  width: "100%",
  height: "100%",
  display: "block",
  objectFit: "contain",
  backgroundColor: "black",
} as const;

// `preload="metadata"` is what reports videoWidth/videoHeight without pulling the
// whole file through the decoder, and the aspect ratio the timeline needs comes
// from that event. The blob URL already holds the bytes, so nothing is fetched twice.
export function AssistantVideoSurface({
  binding,
  style,
  accessibilityLabel,
  testID,
}: AssistantVideoSurfaceProps) {
  const handleLoadedMetadata = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const element = event.currentTarget;
      binding.onLoadedMetadata({
        width: element.videoWidth,
        height: element.videoHeight,
      });
    },
    [binding],
  );

  return (
    <View style={style}>
      <video
        src={binding.uri}
        controls
        playsInline
        preload="metadata"
        aria-label={accessibilityLabel}
        data-testid={testID}
        style={videoStyle}
        onLoadedMetadata={handleLoadedMetadata}
        onError={binding.onError}
      />
    </View>
  );
}
