import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HEARTBEAT_THROTTLE_MS,
  createClientActivityTracker,
  type HeartbeatClient,
  type HeartbeatPayload,
} from "./client-activity-tracker";
import {
  bindWebWindowActivity,
  type WebWindowEvent,
  type WebWindowPort,
} from "./web-window-activity";

const START_MS = new Date("2026-04-19T10:00:00.000Z").getTime();

interface FakeWebWindow extends WebWindowPort {
  activelyVisible: boolean;
  emit(event: WebWindowEvent): void;
  listenerCount(): number;
}

function createFakeWebWindow(input: { activelyVisible: boolean }): FakeWebWindow {
  const listeners = new Map<WebWindowEvent, Set<() => void>>();
  const fake: FakeWebWindow = {
    activelyVisible: input.activelyVisible,
    isActivelyVisible: () => fake.activelyVisible,
    subscribe(event, listener) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listenerCount() {
      let count = 0;
      for (const eventListeners of listeners.values()) count += eventListeners.size;
      return count;
    },
  };
  return fake;
}

interface RecordingHeartbeatClient extends HeartbeatClient {
  readonly recordedHeartbeats: HeartbeatPayload[];
}

function createRecordingHeartbeatClient(): RecordingHeartbeatClient {
  const recordedHeartbeats: HeartbeatPayload[] = [];
  return {
    isConnected: true,
    recordedHeartbeats,
    sendHeartbeat(payload) {
      recordedHeartbeats.push(payload);
    },
  };
}

function bindToFakeWindow(input: { trackerVisible: boolean; windowVisible: boolean }): {
  client: RecordingHeartbeatClient;
  webWindow: FakeWebWindow;
  clock: { now(): number; advance(ms: number): void };
  dispose: () => void;
} {
  let t = START_MS;
  const clock = {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
  const client = createRecordingHeartbeatClient();
  const tracker = createClientActivityTracker({
    client,
    deviceType: "web",
    initialFocusedAgentId: "agent-1",
    initialFocusedTerminalId: null,
    initialAppVisible: input.trackerVisible,
    now: clock.now,
  });
  const webWindow = createFakeWebWindow({ activelyVisible: input.windowVisible });
  const dispose = bindWebWindowActivity(tracker, webWindow);
  return { client, webWindow, clock, dispose };
}

describe("web window activity", () => {
  it("a window blur while the page stays visible reports the app as not visible right away", () => {
    const { client, webWindow, clock } = bindToFakeWindow({
      trackerVisible: true,
      windowVisible: true,
    });

    clock.advance(1_000);
    webWindow.activelyVisible = false;
    webWindow.emit("blur");

    expect(client.recordedHeartbeats).toEqual([
      expect.objectContaining({
        focusedAgentId: "agent-1",
        appVisible: false,
        appVisibilityChangedAt: new Date(START_MS + 1_000).toISOString(),
      }),
    ]);
  });

  it("a window focus reports the app as visible again right away", () => {
    const { client, webWindow, clock } = bindToFakeWindow({
      trackerVisible: false,
      windowVisible: false,
    });

    clock.advance(1_000);
    webWindow.activelyVisible = true;
    webWindow.emit("focus");

    const focusedAt = new Date(START_MS + 1_000).toISOString();
    expect(client.recordedHeartbeats).toEqual([
      expect.objectContaining({
        focusedAgentId: "agent-1",
        appVisible: true,
        appVisibilityChangedAt: focusedAt,
        lastActivityAt: focusedAt,
      }),
      expect.objectContaining({ appVisible: true, lastActivityAt: focusedAt }),
    ]);
  });

  it("a blur that leaves focus inside the page keeps the app visible", () => {
    const { client, webWindow } = bindToFakeWindow({ trackerVisible: true, windowVisible: true });

    webWindow.emit("blur");

    expect(client.recordedHeartbeats).toEqual([]);
  });

  it("hiding the page reports the app as not visible right away", () => {
    const { client, webWindow } = bindToFakeWindow({ trackerVisible: true, windowVisible: true });

    webWindow.activelyVisible = false;
    webWindow.emit("visibilitychange");

    expect(client.recordedHeartbeats).toEqual([expect.objectContaining({ appVisible: false })]);
  });

  it("binding reports the window's current visibility right away", () => {
    const { client } = bindToFakeWindow({ trackerVisible: true, windowVisible: false });

    expect(client.recordedHeartbeats).toEqual([expect.objectContaining({ appVisible: false })]);
  });

  it("binding to a window that matches the tracker sends nothing", () => {
    const { client } = bindToFakeWindow({ trackerVisible: true, windowVisible: true });

    expect(client.recordedHeartbeats).toEqual([]);
  });

  it("pointer, key, wheel and touch input record user activity", () => {
    const { client, webWindow, clock } = bindToFakeWindow({
      trackerVisible: true,
      windowVisible: true,
    });

    for (const event of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
      clock.advance(ACTIVITY_HEARTBEAT_THROTTLE_MS);
      webWindow.emit(event);
      expect(client.recordedHeartbeats.at(-1)).toMatchObject({
        lastActivityAt: new Date(clock.now()).toISOString(),
      });
    }
    expect(client.recordedHeartbeats).toHaveLength(4);
  });

  it("disposing removes every window listener", () => {
    const { client, webWindow, dispose } = bindToFakeWindow({
      trackerVisible: true,
      windowVisible: true,
    });
    expect(webWindow.listenerCount()).toBe(7);

    dispose();
    webWindow.activelyVisible = false;
    webWindow.emit("blur");
    webWindow.emit("pointerdown");

    expect(webWindow.listenerCount()).toBe(0);
    expect(client.recordedHeartbeats).toEqual([]);
  });
});
