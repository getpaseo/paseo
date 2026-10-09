export const HEARTBEAT_INTERVAL_MS = 15_000;
export const ACTIVITY_HEARTBEAT_THROTTLE_MS = 5_000;
export const DESKTOP_IDLE_POLL_INTERVAL_MS = 5_000;

export interface HeartbeatPayload {
  deviceType: "web" | "mobile";
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
  lastActivityAt: string;
  appVisible: boolean;
  appVisibilityChangedAt?: string;
}

export interface HeartbeatClient {
  readonly isConnected: boolean;
  sendHeartbeat(payload: HeartbeatPayload): void;
}

export interface ClientActivityTrackerInput {
  client: HeartbeatClient;
  deviceType: "web" | "mobile";
  initialFocusedAgentId: string | null;
  initialFocusedTerminalId: string | null;
  initialAppVisible: boolean;
  now: () => number;
  onAppResumed?: (awayMs: number) => void;
}

export interface ClientActivityTracker {
  recordUserActivity(): void;
  maybeSendImmediateHeartbeat(): void;
  setFocusedAgentId(id: string | null): void;
  setFocusedTerminalId(id: string | null): void;
  notifyAppVisibility(visible: boolean): { changed: boolean };
  notifySystemIdleMs(idleMs: number | null): void;
  sendHeartbeat(): void;
}

export function createClientActivityTracker(
  input: ClientActivityTrackerInput,
): ClientActivityTracker {
  const { client, deviceType, now, onAppResumed } = input;
  let lastActivityAtMs = now();
  let appVisible = input.initialAppVisible;
  let appVisibilityChangedAtMs = now();
  let backgroundedAtMs: number | null = appVisible ? null : now();
  let focusedAgentId = input.initialFocusedAgentId;
  let focusedTerminalId = input.initialFocusedTerminalId;
  let lastImmediateHeartbeatAtMs = 0;

  function sendHeartbeat(): void {
    if (!client.isConnected) return;
    client.sendHeartbeat({
      deviceType,
      focusedAgentId,
      focusedTerminalId,
      lastActivityAt: new Date(lastActivityAtMs).toISOString(),
      appVisible,
      appVisibilityChangedAt: new Date(appVisibilityChangedAtMs).toISOString(),
    });
  }

  function recordUserActivity(): void {
    lastActivityAtMs = now();
  }

  function maybeSendImmediateHeartbeat(): void {
    if (!client.isConnected) return;
    const t = now();
    if (t - lastImmediateHeartbeatAtMs < ACTIVITY_HEARTBEAT_THROTTLE_MS) return;
    lastImmediateHeartbeatAtMs = t;
    sendHeartbeat();
  }

  return {
    recordUserActivity,
    maybeSendImmediateHeartbeat,
    setFocusedAgentId(id) {
      if (focusedAgentId === id) return;
      focusedAgentId = id;
      recordUserActivity();
      sendHeartbeat();
    },
    setFocusedTerminalId(id) {
      if (focusedTerminalId === id) return;
      focusedTerminalId = id;
      recordUserActivity();
      sendHeartbeat();
    },
    notifyAppVisibility(nextVisible) {
      if (appVisible === nextVisible) return { changed: false };
      appVisible = nextVisible;
      appVisibilityChangedAtMs = now();
      if (!nextVisible) {
        backgroundedAtMs = now();
        return { changed: true };
      }
      const at = backgroundedAtMs;
      backgroundedAtMs = null;
      if (at !== null) {
        onAppResumed?.(Math.max(0, now() - at));
      }
      recordUserActivity();
      return { changed: true };
    },
    notifySystemIdleMs(idleMs) {
      if (idleMs === null) return;
      const systemLastActivityAtMs = now() - idleMs;
      if (systemLastActivityAtMs > lastActivityAtMs) {
        lastActivityAtMs = systemLastActivityAtMs;
      }
    },
    sendHeartbeat,
  };
}
