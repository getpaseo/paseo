import React, { useEffect, useRef, type CSSProperties } from "react";
import type { VideoPlayerProps } from "./player.types";

const videoStyle: CSSProperties = {
  width: "auto",
  height: "auto",
  maxWidth: "100%",
  maxHeight: "100%",
  minHeight: 0,
  objectFit: "contain",
};

export function VideoPlayer({ uri, active, onLoad, onError }: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!active) video?.pause();
    return () => video?.pause();
  }, [active]);

  return (
    <video
      ref={ref}
      src={uri}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={onLoad}
      onError={onError}
      style={videoStyle}
    />
  );
}
