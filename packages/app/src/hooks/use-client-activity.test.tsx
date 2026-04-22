import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClientActivity } from "./use-client-activity";

type HeartbeatPayload = {
  deviceType: "web" | "mobile";
  focusedAgentId: string | null;
  lastActivityAt: string;
  appVisible: boolean;
  appVisibilityChangedAt?: string;
};

const { platformState, getDesktopSystemIdleTimeMs } = vi.hoisted(() => ({
  platformState: {
    isWeb: true,
    isNative: false,
    isElectron: false,
  },
  getDesktopSystemIdleTimeMs: vi.fn<() => Promise<number | null>>(),
}));

vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return platformState.isWeb;
  },
  get isNative() {
    return platformState.isNative;
  },
  getIsElectron: () => platformState.isElectron,
}));

vi.mock("@/desktop/electron/idle", () => ({
  getDesktopSystemIdleTimeMs,
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn(() => ({
      remove: vi.fn(),
    })),
  },
}));

vi.mock("@server/client/daemon-client", () => ({}));

function createTestClient() {
  return {
    isConnected: true,
    subscribeConnectionStatus: vi.fn((listener: (state: { status: "connected" }) => void) => {
      listener({ status: "connected" });
      return vi.fn();
    }),
    sendHeartbeat: vi.fn<(payload: HeartbeatPayload) => void>(),
  };
}

function latestHeartbeat(client: ReturnType<typeof createTestClient>): HeartbeatPayload {
  const call = client.sendHeartbeat.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected a heartbeat");
  }
  return call[0];
}

function heartbeatTimeMs(client: ReturnType<typeof createTestClient>): number {
  return new Date(latestHeartbeat(client).lastActivityAt).getTime();
}

async function renderActivityHook({
  client = createTestClient(),
  focusedAgentId = "agent-1",
}: {
  client?: ReturnType<typeof createTestClient>;
  focusedAgentId?: string | null;
} = {}) {
  function Probe({ focusedAgentId }: { focusedAgentId: string | null }) {
    useClientActivity({
      client: client as unknown as Parameters<typeof useClientActivity>[0]["client"],
      focusedAgentId,
    });
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<Probe focusedAgentId={focusedAgentId} />);
  });

  const rerender = async (nextFocusedAgentId: string | null) => {
    await act(async () => {
      root.render(<Probe focusedAgentId={nextFocusedAgentId} />);
    });
  };

  return { client, rerender, root };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useClientActivity", () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T10:00:00.000Z"));

    platformState.isWeb = true;
    platformState.isNative = false;
    platformState.isElectron = false;
    getDesktopSystemIdleTimeMs.mockReset();

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost",
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("updates lastActivityAt from web pointer activity", async () => {
    const rendered = await renderActivityHook();
    root = rendered.root;

    vi.setSystemTime(new Date("2026-04-19T10:00:05.250Z"));
    window.dispatchEvent(new window.Event("pointerdown"));

    expect(heartbeatTimeMs(rendered.client)).toBe(Date.now());
    expect(getDesktopSystemIdleTimeMs).not.toHaveBeenCalled();
  });

  it("sends one immediate heartbeat when the focused agent changes", async () => {
    const rendered = await renderActivityHook();
    root = rendered.root;

    expect(rendered.client.sendHeartbeat).toHaveBeenCalledTimes(1);
    rendered.client.sendHeartbeat.mockClear();

    vi.setSystemTime(new Date("2026-04-19T10:00:05.000Z"));
    await rendered.rerender("agent-2");

    expect(rendered.client.subscribeConnectionStatus).toHaveBeenCalledTimes(1);
    expect(rendered.client.sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(latestHeartbeat(rendered.client)).toMatchObject({
      focusedAgentId: "agent-2",
      lastActivityAt: "2026-04-19T10:00:05.000Z",
    });
  });

  it("drives lastActivityAt forward from Electron idle polling", async () => {
    platformState.isElectron = true;
    getDesktopSystemIdleTimeMs.mockResolvedValue(0);
    const rendered = await renderActivityHook();
    root = rendered.root;

    await advance(5_000);
    expect(getDesktopSystemIdleTimeMs).toHaveBeenCalledTimes(1);

    await advance(10_000);

    expect(heartbeatTimeMs(rendered.client)).toBe(Date.now());
  });

  it("sets lastActivityAt to Date.now() minus the Electron idle time", async () => {
    platformState.isElectron = true;
    getDesktopSystemIdleTimeMs.mockResolvedValue(2_000);
    const rendered = await renderActivityHook();
    root = rendered.root;

    await advance(5_000);
    await advance(10_000);

    expect(heartbeatTimeMs(rendered.client)).toBe(Date.now() - 2_000);
  });

  it("skips failed Electron idle polls", async () => {
    platformState.isElectron = true;
    getDesktopSystemIdleTimeMs.mockResolvedValue(null);
    const rendered = await renderActivityHook();
    root = rendered.root;
    const previousLastActivityAt = heartbeatTimeMs(rendered.client);

    await advance(5_000);
    await advance(10_000);

    expect(heartbeatTimeMs(rendered.client)).toBe(previousLastActivityAt);
  });

  it("never moves lastActivityAt backward from an idle poll", async () => {
    platformState.isElectron = true;
    getDesktopSystemIdleTimeMs.mockResolvedValue(20_000);
    const rendered = await renderActivityHook();
    root = rendered.root;

    vi.setSystemTime(new Date("2026-04-19T10:00:05.000Z"));
    window.dispatchEvent(new window.Event("pointerdown"));
    const pointerActivityAt = latestHeartbeat(rendered.client).lastActivityAt;

    await advance(5_000);
    expect(getDesktopSystemIdleTimeMs).toHaveBeenCalled();

    await advance(10_000);

    expect(latestHeartbeat(rendered.client).lastActivityAt).toBe(pointerActivityAt);
  });

  it("keeps an Electron pointerdown newer than a stale idle poll", async () => {
    platformState.isElectron = true;
    getDesktopSystemIdleTimeMs.mockResolvedValue(20_000);
    const rendered = await renderActivityHook();
    root = rendered.root;

    await advance(4_500);
    window.dispatchEvent(new window.Event("pointerdown"));
    const pointerActivityAt = latestHeartbeat(rendered.client).lastActivityAt;

    await advance(500);
    expect(getDesktopSystemIdleTimeMs).toHaveBeenCalled();

    await advance(10_000);

    expect(latestHeartbeat(rendered.client).lastActivityAt).toBe(pointerActivityAt);
  });
});
