import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getIsElectron, isWeb, isNative } from "@/constants/platform";
import { readDesktopSystemIdleTimeMs } from "@/desktop/electron/idle";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  type ClientActivityTracker,
  createClientActivityTracker,
  DESKTOP_IDLE_POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./client-activity-tracker";

interface ClientActivityOptions {
  client: DaemonClient;
  focusedAgentId: string | null;
  onAppResumed?: (awayMs: number) => void;
}

/**
 * Handles client activity reporting:
 * - Heartbeat sending every 15 seconds
 * - App visibility tracking
 * - Records lastActivityAt only on real user activity (not on heartbeat)
 */
export function useClientActivity({
  client,
  focusedAgentId,
  onAppResumed,
}: ClientActivityOptions): void {
  const onAppResumedRef = useRef(onAppResumed);
  onAppResumedRef.current = onAppResumed;

  const trackerRef = useRef<ClientActivityTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createClientActivityTracker({
      client,
      deviceType: isWeb ? "web" : "mobile",
      initialFocusedAgentId: focusedAgentId,
      initialAppVisible: AppState.currentState === "active",
      now: () => Date.now(),
      onAppResumed: (awayMs) => onAppResumedRef.current?.(awayMs),
    });
  }
  const tracker = trackerRef.current;

  // Track app visibility via AppState (native).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      tracker.notifyAppVisibility(nextState === "active");
      tracker.sendHeartbeat();
    });
    return () => subscription.remove();
  }, [tracker]);

  // Track user activity and visibility on web.
  useEffect(() => {
    if (isNative) return;
    if (typeof document === "undefined") return;

    const handleUserActivity = () => {
      tracker.recordUserActivity();
      tracker.maybeSendImmediateHeartbeat();
    };

    const handleVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      const { changed } = tracker.notifyAppVisibility(visible);
      if (changed && visible) {
        tracker.maybeSendImmediateHeartbeat();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleUserActivity);
    window.addEventListener("pointerdown", handleUserActivity, { passive: true });
    window.addEventListener("keydown", handleUserActivity);
    window.addEventListener("wheel", handleUserActivity, { passive: true });
    window.addEventListener("touchstart", handleUserActivity, { passive: true });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleUserActivity);
      window.removeEventListener("pointerdown", handleUserActivity);
      window.removeEventListener("keydown", handleUserActivity);
      window.removeEventListener("wheel", handleUserActivity);
      window.removeEventListener("touchstart", handleUserActivity);
    };
  }, [tracker]);

  // Track OS-wide activity in Electron so backgrounded desktop windows still report presence.
  useEffect(() => {
    if (!getIsElectron()) return;

    let disposed = false;
    const pollSystemIdleTime = async () => {
      const systemIdleMs = await readDesktopSystemIdleTimeMs(invokeDesktopCommand);
      if (disposed) return;
      tracker.notifySystemIdleMs(systemIdleMs);
    };

    const interval = setInterval(() => {
      void pollSystemIdleTime();
    }, DESKTOP_IDLE_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [tracker]);

  // Send heartbeat on focused agent change.
  useEffect(() => {
    tracker.setFocusedAgentId(focusedAgentId);
  }, [focusedAgentId, tracker]);

  // Periodic heartbeat gated by connection status.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId) clearInterval(intervalId);
      tracker.sendHeartbeat();
      intervalId = setInterval(() => tracker.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    };

    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        start();
      } else {
        stop();
      }
    });

    return () => {
      unsubscribe();
      stop();
    };
  }, [client, tracker]);
}
