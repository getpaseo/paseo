import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getIsElectron, isWeb, isNative } from "@/constants/platform";
import { readDesktopSystemIdleTimeMs } from "@/desktop/electron/idle";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import {
  type ClientActivityTracker,
  createClientActivityTracker,
  DESKTOP_IDLE_POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./client-activity-tracker";

interface ClientActivityOptions {
  client: DaemonClient;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
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
  focusedTerminalId,
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
      initialFocusedTerminalId: focusedTerminalId,
      // On web, "in foreground" means the tab is visible AND the window has OS focus —
      // a visible-but-unfocused tab must still be treated as backgrounded so attention
      // notifications fire for it instead of being suppressed as "actively viewed".
      initialAppVisible: isWeb ? getIsAppActivelyVisible() : AppState.currentState === "active",
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

    // "Foreground" combines page visibility and window focus. document.visibilityState
    // alone stays "visible" while the window is merely unfocused (e.g. the user switched
    // to another app), which would otherwise keep suppressing notifications for a session
    // the user isn't actually looking at.
    const handleActiveVisibilityChange = () => {
      const visible = getIsAppActivelyVisible();
      const { changed } = tracker.notifyAppVisibility(visible);
      if (changed && visible) {
        tracker.maybeSendImmediateHeartbeat();
      }
    };

    document.addEventListener("visibilitychange", handleActiveVisibilityChange);
    window.addEventListener("focus", handleActiveVisibilityChange);
    window.addEventListener("blur", handleActiveVisibilityChange);
    window.addEventListener("focus", handleUserActivity);
    window.addEventListener("pointerdown", handleUserActivity, { passive: true });
    window.addEventListener("keydown", handleUserActivity);
    window.addEventListener("wheel", handleUserActivity, { passive: true });
    window.addEventListener("touchstart", handleUserActivity, { passive: true });

    return () => {
      document.removeEventListener("visibilitychange", handleActiveVisibilityChange);
      window.removeEventListener("focus", handleActiveVisibilityChange);
      window.removeEventListener("blur", handleActiveVisibilityChange);
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

  // Send heartbeat on focused terminal change.
  useEffect(() => {
    tracker.setFocusedTerminalId(focusedTerminalId);
  }, [focusedTerminalId, tracker]);

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
