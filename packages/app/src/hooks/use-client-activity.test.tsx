/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatPayload } from "./client-activity-tracker";
import { reportNativeUserActivity } from "./native-user-activity";
import { useClientActivity } from "./use-client-activity";

vi.mock("@/constants/platform", () => ({
  isWeb: false,
  isNative: true,
  getIsElectron: () => false,
}));

const START_MS = new Date("2026-10-28T10:00:00.000Z").getTime();
const READING_WITHOUT_NAVIGATING_MS = 4 * 60_000;

function createConnectedClient() {
  const heartbeats: HeartbeatPayload[] = [];
  const client = {
    isConnected: true,
    sendHeartbeat: (payload: HeartbeatPayload) => heartbeats.push(payload),
    subscribeConnectionStatus: (listener: (state: { status: string }) => void) => {
      listener({ status: "connected" });
      return () => undefined;
    },
  } as unknown as DaemonClient;
  return { client, heartbeats };
}

describe("useClientActivity on native", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a client reading one agent present while the user touches or types", () => {
    const { client, heartbeats } = createConnectedClient();
    renderHook(() =>
      useClientActivity({ client, focusedAgentId: "agent-1", focusedTerminalId: null }),
    );

    vi.advanceTimersByTime(READING_WITHOUT_NAVIGATING_MS);
    reportNativeUserActivity();

    expect(heartbeats.at(-1)).toMatchObject({
      deviceType: "mobile",
      focusedAgentId: "agent-1",
      lastActivityAt: new Date(START_MS + READING_WITHOUT_NAVIGATING_MS).toISOString(),
    });
  });

  it("stops reporting activity for a session after it unmounts", () => {
    const { client, heartbeats } = createConnectedClient();
    const { unmount } = renderHook(() =>
      useClientActivity({ client, focusedAgentId: "agent-1", focusedTerminalId: null }),
    );
    unmount();
    const sentBeforeActivity = heartbeats.length;

    vi.advanceTimersByTime(READING_WITHOUT_NAVIGATING_MS);
    reportNativeUserActivity();

    expect(heartbeats).toHaveLength(sentBeforeActivity);
  });
});
