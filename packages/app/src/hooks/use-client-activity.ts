import { useEffect, useRef, useCallback } from "react";
import { AppState, Platform } from "react-native";
import type { DaemonClient } from "@server/client/daemon-client";

const HEARTBEAT_INTERVAL_MS = 15_000;
const ACTIVITY_HEARTBEAT_THROTTLE_MS = 5_000;

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
  const lastActivityAtRef = useRef<Date>(new Date());
  const appVisibleRef = useRef(AppState.currentState === "active");
  const appVisibilityChangedAtRef = useRef<Date>(new Date());
  const backgroundedAtMsRef = useRef<number | null>(
    AppState.currentState === "active" ? null : Date.now()
  );
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFocusedAgentIdRef = useRef<string | null>(focusedAgentId);
  const lastImmediateHeartbeatAtRef = useRef<number>(0);

  const deviceType = Platform.OS === "web" ? "web" : "mobile";

  const recordUserActivity = useCallback(() => {
    lastActivityAtRef.current = new Date();
  }, []);

  const sendHeartbeat = useCallback(() => {
    if (!client.isConnected) return;
    client.sendHeartbeat({
      deviceType,
      focusedAgentId,
      lastActivityAt: lastActivityAtRef.current.toISOString(),
      appVisible: appVisibleRef.current,
      appVisibilityChangedAt: appVisibilityChangedAtRef.current.toISOString(),
    });
  }, [client, deviceType, focusedAgentId]);

  const setAppVisible = useCallback(
    (nextVisible: boolean) => {
      const previousVisible = appVisibleRef.current;
      if (previousVisible === nextVisible) {
        return;
      }
      appVisibleRef.current = nextVisible;
      appVisibilityChangedAtRef.current = new Date();

      if (!nextVisible) {
        backgroundedAtMsRef.current = Date.now();
        return;
      }

      const backgroundedAt = backgroundedAtMsRef.current;
      backgroundedAtMsRef.current = null;
      if (backgroundedAt !== null) {
        onAppResumed?.(Math.max(0, Date.now() - backgroundedAt));
      }
      recordUserActivity();
    },
    [onAppResumed, recordUserActivity]
  );

  const maybeSendImmediateHeartbeat = useCallback(() => {
    if (!client.isConnected) return;
    const now = Date.now();
    if (now - lastImmediateHeartbeatAtRef.current < ACTIVITY_HEARTBEAT_THROTTLE_MS) {
      return;
    }
    lastImmediateHeartbeatAtRef.current = now;
    sendHeartbeat();
  }, [client, sendHeartbeat]);

  // Track app visibility
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppVisible(nextState === "active");
      // Send immediately on visibility changes so the server can adapt streaming behavior.
      sendHeartbeat();
    });

    return () => subscription.remove();
  }, [sendHeartbeat, setAppVisible]);

  // Track user activity on web for accurate staleness.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof document === "undefined") return;

    const handleUserActivity = () => {
      recordUserActivity();
      maybeSendImmediateHeartbeat();
    };

    const handleVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      setAppVisible(visible);
      if (visible) {
        maybeSendImmediateHeartbeat();
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
  }, [maybeSendImmediateHeartbeat, recordUserActivity, setAppVisible]);

  // Send heartbeat on focused agent change
  useEffect(() => {
    if (prevFocusedAgentIdRef.current !== focusedAgentId) {
      prevFocusedAgentIdRef.current = focusedAgentId;
      recordUserActivity();
      sendHeartbeat();
    }
  }, [focusedAgentId, recordUserActivity, sendHeartbeat]);

  // Periodic heartbeat
  useEffect(() => {
    const startHeartbeat = () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      sendHeartbeat();
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };

    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        startHeartbeat();
      } else {
        stopHeartbeat();
      }
    });

    if (client.isConnected) {
      startHeartbeat();
    }

    return () => {
      unsubscribe();
      stopHeartbeat();
    };
  }, [client, sendHeartbeat]);
}
