import { useEffect, useRef, useCallback } from "react";
import { AppState, Platform } from "react-native";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";

const HEARTBEAT_INTERVAL_MS = 15_000;

interface ClientActivityOptions {
  client: DaemonClientV2;
  focusedAgentId: string | null;
}

/**
 * Handles client activity reporting:
 * - Heartbeat sending every 15 seconds
 * - App visibility tracking (updates lastActivityAt on foreground)
 * - Sends heartbeat immediately when focused agent changes
 */
export function useClientActivity({ client, focusedAgentId }: ClientActivityOptions): void {
  const lastActivityAtRef = useRef<Date>(new Date());
  const appVisibleRef = useRef(AppState.currentState === "active");
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevFocusedAgentIdRef = useRef<string | null>(focusedAgentId);

  const deviceType = Platform.OS === "web" ? "web" : "mobile";

  const recordUserActivity = useCallback(() => {
    lastActivityAtRef.current = new Date();
  }, []);

  const sendHeartbeat = useCallback(() => {
    if (!client.isConnected) {
      console.log("[ClientActivity] sendHeartbeat skipped - not connected");
      return;
    }
    lastActivityAtRef.current = new Date();
    console.log("[ClientActivity] sendHeartbeat", {
      deviceType,
      focusedAgentId,
      lastActivityAt: lastActivityAtRef.current.toISOString(),
      appVisible: appVisibleRef.current,
    });
    client.sendHeartbeat({
      deviceType,
      focusedAgentId,
      lastActivityAt: lastActivityAtRef.current.toISOString(),
      appVisible: appVisibleRef.current,
    });
  }, [client, deviceType, focusedAgentId]);

  // Track app visibility
  useEffect(() => {
    console.log("[ClientActivity] AppState effect mounted, current:", AppState.currentState);
    const subscription = AppState.addEventListener("change", (nextState) => {
      console.log("[ClientActivity] AppState changed:", nextState);
      appVisibleRef.current = nextState === "active";
      if (nextState === "active") {
        recordUserActivity();
      }
    });

    return () => subscription.remove();
  }, [recordUserActivity]);

  // Send heartbeat on focused agent change
  useEffect(() => {
    if (prevFocusedAgentIdRef.current !== focusedAgentId) {
      console.log("[ClientActivity] focusedAgentId changed:", prevFocusedAgentIdRef.current, "->", focusedAgentId);
      prevFocusedAgentIdRef.current = focusedAgentId;
      sendHeartbeat();
    }
  }, [focusedAgentId, sendHeartbeat]);

  // Periodic heartbeat
  useEffect(() => {
    console.log("[ClientActivity] Heartbeat effect mounted, isConnected:", client.isConnected);

    const startHeartbeat = () => {
      console.log("[ClientActivity] startHeartbeat called");
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      sendHeartbeat();
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = () => {
      console.log("[ClientActivity] stopHeartbeat called");
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };

    const unsubscribe = client.subscribeConnectionStatus((state) => {
      console.log("[ClientActivity] Connection status changed:", state.status);
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
