import { useEffect, useRef, useCallback } from "react";
import { AppState, Platform } from "react-native";
import type { DaemonClient } from "@server/client/daemon-client";

const HEARTBEAT_INTERVAL_MS = 15_000;
const ACTIVITY_HEARTBEAT_THROTTLE_MS = 5_000;

interface ClientActivityOptions {
  client: DaemonClient;
  focusedAgentId: string | null;
}

/**
 * Handles client activity reporting:
 * - Heartbeat sending every 15 seconds
 * - App visibility tracking
 * - Records lastActivityAt only on real user activity (not on heartbeat)
 */
export function useClientActivity({ client, focusedAgentId }: ClientActivityOptions): void {
  const lastActivityAtRef = useRef<Date>(new Date());
  const appVisibleRef = useRef(AppState.currentState === "active");
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
    });
  }, [client, deviceType, focusedAgentId]);

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
      appVisibleRef.current = nextState === "active";
      if (nextState === "active") {
        recordUserActivity();
      }
      // Send immediately on visibility changes so the server can adapt streaming behavior.
      sendHeartbeat();
    });

    return () => subscription.remove();
  }, [recordUserActivity, sendHeartbeat]);

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
      appVisibleRef.current = visible;
      if (visible) {
        recordUserActivity();
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
  }, [maybeSendImmediateHeartbeat, recordUserActivity]);

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
