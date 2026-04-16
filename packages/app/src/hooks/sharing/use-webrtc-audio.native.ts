import { useCallback, useState } from "react";
import type { Room } from "./colyseus-client";

/**
 * WebRTC audio hook stub for React Native.
 *
 * Full implementation requires `react-native-webrtc` package.
 * This stub provides the same interface so the app compiles
 * on native but audio is not available until the package is installed.
 */
export function useWebRTCAudio(_room: Room | null, _myUserId: string | null) {
  const [audioEnabled] = useState(false);

  const toggleAudio = useCallback(async (_participantUserIds: string[]) => {
    console.warn("[WebRTC] Audio not available on native yet. Install react-native-webrtc.");
  }, []);

  const startAudio = useCallback(async (_participantUserIds: string[]) => {
    console.warn("[WebRTC] Audio not available on native yet.");
  }, []);

  const stopAudio = useCallback(() => {
    console.warn("[WebRTC] Audio not available on native yet.");
  }, []);

  return {
    audioEnabled,
    peerCount: 0,
    toggleAudio,
    startAudio,
    stopAudio,
  };
}
