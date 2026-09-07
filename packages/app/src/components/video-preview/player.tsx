import React, { useEffect, useMemo } from "react";
import { StyleSheet } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import type { VideoPlayerProps } from "./player.types";

export function VideoPlayer({ uri, active, onLoad, onError }: VideoPlayerProps) {
  const player = useVideoPlayer(uri);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { videoTrack } = useEvent(player, "videoTrackChange", { videoTrack: player.videoTrack });
  const videoStyle = useMemo(
    () => [styles.video, { maxWidth: videoTrack?.size.width, maxHeight: videoTrack?.size.height }],
    [videoTrack],
  );

  useEffect(() => {
    if (!active) player.pause();
  }, [active, player]);

  useEffect(() => {
    if (status === "readyToPlay") onLoad();
    if (status === "error") onError();
  }, [onError, onLoad, status]);

  return (
    <VideoView
      player={player}
      style={videoStyle}
      contentFit="contain"
      nativeControls
      allowsFullscreen
    />
  );
}

const styles = StyleSheet.create({ video: { flex: 1, width: "100%" } });
