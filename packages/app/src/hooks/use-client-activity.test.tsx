/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HeartbeatPayload } from "./client-activity-tracker";
import { useClientActivity } from "./use-client-activity";

function createConnectedDaemonClient() {
  const heartbeats: HeartbeatPayload[] = [];
  const client = {
    isConnected: true,
    sendHeartbeat(payload: HeartbeatPayload) {
      heartbeats.push(payload);
    },
    subscribeConnectionStatus(listener: (state: { status: "connected" }) => void) {
      listener({ status: "connected" });
      return () => {};
    },
  };
  return {
    client: client as unknown as DaemonClient,
    latestHeartbeat(): HeartbeatPayload {
      const last = heartbeats.at(-1);
      if (!last) throw new Error("Expected a heartbeat");
      return last;
    },
  };
}

function setWindowFocused(focused: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

function renderClientActivity(client: DaemonClient): void {
  renderHook(() =>
    useClientActivity({ client, focusedAgentId: "agent-1", focusedTerminalId: null }),
  );
}

describe("client activity on web", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a window blur while the page stays visible reports the app as not visible", () => {
    setWindowFocused(true);
    const daemon = createConnectedDaemonClient();
    renderClientActivity(daemon.client);

    setWindowFocused(false);
    window.dispatchEvent(new Event("blur"));

    expect(document.visibilityState).toBe("visible");
    expect(daemon.latestHeartbeat()).toMatchObject({
      focusedAgentId: "agent-1",
      appVisible: false,
    });
  });

  it("a window that starts unfocused reports the app as not visible until it gains focus", () => {
    setWindowFocused(false);
    const daemon = createConnectedDaemonClient();
    renderClientActivity(daemon.client);

    expect(daemon.latestHeartbeat()).toMatchObject({
      focusedAgentId: "agent-1",
      appVisible: false,
    });

    setWindowFocused(true);
    window.dispatchEvent(new Event("focus"));

    expect(daemon.latestHeartbeat()).toMatchObject({
      focusedAgentId: "agent-1",
      appVisible: true,
    });
  });
});
