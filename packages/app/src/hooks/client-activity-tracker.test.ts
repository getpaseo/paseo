import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HEARTBEAT_THROTTLE_MS,
  createClientActivityTracker,
  type ClientActivityTracker,
  type ClientActivityTrackerInput,
  type HeartbeatClient,
  type HeartbeatPayload,
} from "./client-activity-tracker";

const START_MS = new Date("2026-04-19T10:00:00.000Z").getTime();

function createTestClock(initial = START_MS) {
  let t = initial;
  return {
    now: () => t,
    set(ms: number) {
      t = ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

interface FakeHeartbeatClient extends HeartbeatClient {
  isConnected: boolean;
  recordedHeartbeats: HeartbeatPayload[];
  latest(): HeartbeatPayload;
  reset(): void;
}

function createFakeHeartbeatClient(): FakeHeartbeatClient {
  const recorded: HeartbeatPayload[] = [];
  return {
    isConnected: true,
    recordedHeartbeats: recorded,
    sendHeartbeat(payload) {
      recorded.push(payload);
    },
    latest() {
      const last = recorded.at(-1);
      if (!last) throw new Error("Expected a heartbeat");
      return last;
    },
    reset() {
      recorded.length = 0;
    },
  };
}

function buildTracker(
  overrides: Partial<ClientActivityTrackerInput> & {
    client?: FakeHeartbeatClient;
    clock?: ReturnType<typeof createTestClock>;
  } = {},
): {
  tracker: ClientActivityTracker;
  client: FakeHeartbeatClient;
  clock: ReturnType<typeof createTestClock>;
} {
  const client = overrides.client ?? createFakeHeartbeatClient();
  const clock = overrides.clock ?? createTestClock();
  const tracker = createClientActivityTracker({
    client,
    deviceType: overrides.deviceType ?? "web",
    initialFocusedAgentId: overrides.initialFocusedAgentId ?? "agent-1",
    initialAppVisible: overrides.initialAppVisible ?? true,
    now: clock.now,
    onAppResumed: overrides.onAppResumed,
  });
  return { tracker, client, clock };
}

describe("client activity tracker", () => {
  it("includes the latest user-activity time in the next heartbeat", () => {
    const { tracker, client, clock } = buildTracker();

    clock.advance(5_250);
    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();

    expect(client.latest()).toMatchObject({
      deviceType: "web",
      focusedAgentId: "agent-1",
      appVisible: true,
      lastActivityAt: new Date(START_MS + 5_250).toISOString(),
    });
  });

  it("throttles repeated immediate heartbeats within the throttle window", () => {
    const { tracker, client, clock } = buildTracker();

    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();
    expect(client.recordedHeartbeats).toHaveLength(1);

    clock.advance(ACTIVITY_HEARTBEAT_THROTTLE_MS - 1);
    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();
    expect(client.recordedHeartbeats).toHaveLength(1);

    clock.advance(1);
    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();
    expect(client.recordedHeartbeats).toHaveLength(2);
  });

  it("sends one immediate heartbeat when the focused agent changes", () => {
    const { tracker, client, clock } = buildTracker();
    tracker.sendHeartbeat(); // simulate the on-connect heartbeat
    expect(client.recordedHeartbeats).toHaveLength(1);
    client.reset();

    clock.advance(5_000);
    tracker.setFocusedAgentId("agent-2");

    expect(client.recordedHeartbeats).toHaveLength(1);
    expect(client.latest()).toMatchObject({
      focusedAgentId: "agent-2",
      lastActivityAt: new Date(START_MS + 5_000).toISOString(),
    });
  });

  it("ignores focused-agent updates that do not change the value", () => {
    const { tracker, client } = buildTracker({ initialFocusedAgentId: "agent-1" });

    tracker.setFocusedAgentId("agent-1");

    expect(client.recordedHeartbeats).toHaveLength(0);
  });

  it("drives lastActivityAt forward from system idle polling", () => {
    const { tracker, client, clock } = buildTracker();

    clock.advance(5_000);
    tracker.notifySystemIdleMs(0);
    clock.advance(5_000);
    tracker.notifySystemIdleMs(0);
    clock.advance(5_000);
    tracker.notifySystemIdleMs(0);
    tracker.sendHeartbeat();

    expect(client.latest().lastActivityAt).toBe(new Date(START_MS + 15_000).toISOString());
  });

  it("sets lastActivityAt to now minus the system idle time", () => {
    const { tracker, client, clock } = buildTracker();

    clock.advance(15_000);
    tracker.notifySystemIdleMs(2_000);
    tracker.sendHeartbeat();

    expect(client.latest().lastActivityAt).toBe(new Date(START_MS + 13_000).toISOString());
  });

  it("ignores failed system idle polls", () => {
    const { tracker, client, clock } = buildTracker();
    tracker.sendHeartbeat();
    const before = client.latest().lastActivityAt;

    clock.advance(15_000);
    tracker.notifySystemIdleMs(null);
    tracker.sendHeartbeat();

    expect(client.latest().lastActivityAt).toBe(before);
  });

  it("never moves lastActivityAt backward from a system idle poll", () => {
    const { tracker, client, clock } = buildTracker();

    clock.advance(5_000);
    tracker.recordUserActivity();
    const userActivityAt = new Date(clock.now()).toISOString();

    clock.advance(10_000);
    tracker.notifySystemIdleMs(20_000); // would imply activity 5_000 ms before start
    tracker.sendHeartbeat();

    expect(client.latest().lastActivityAt).toBe(userActivityAt);
  });

  it("emits an appVisibilityChangedAt and runs onAppResumed when becoming visible after backgrounding", () => {
    let resumed: number | null = null;
    const { tracker, client, clock } = buildTracker({
      initialAppVisible: true,
      onAppResumed: (awayMs) => {
        resumed = awayMs;
      },
    });

    clock.advance(2_000);
    const hideTransition = tracker.notifyAppVisibility(false);
    expect(hideTransition.changed).toBe(true);

    clock.advance(8_000);
    const showTransition = tracker.notifyAppVisibility(true);
    expect(showTransition.changed).toBe(true);
    expect(resumed).toBe(8_000);

    tracker.sendHeartbeat();
    expect(client.latest()).toMatchObject({
      appVisible: true,
      appVisibilityChangedAt: new Date(START_MS + 10_000).toISOString(),
      lastActivityAt: new Date(START_MS + 10_000).toISOString(),
    });
  });

  it("treats no-op visibility transitions as no change", () => {
    const { tracker } = buildTracker({ initialAppVisible: true });
    const result = tracker.notifyAppVisibility(true);
    expect(result.changed).toBe(false);
  });

  it("does not call onAppResumed when transitioning visible→visible or from initial-visible to hidden", () => {
    let resumed: number | null = null;
    const { tracker } = buildTracker({
      initialAppVisible: true,
      onAppResumed: (awayMs) => {
        resumed = awayMs;
      },
    });

    tracker.notifyAppVisibility(false);
    expect(resumed).toBeNull();
  });

  it("skips heartbeats while the client is disconnected", () => {
    const client = createFakeHeartbeatClient();
    client.isConnected = false;
    const { tracker, clock } = buildTracker({ client });

    tracker.sendHeartbeat();
    tracker.recordUserActivity();
    tracker.maybeSendImmediateHeartbeat();
    clock.advance(10_000);
    tracker.setFocusedAgentId("agent-2");

    expect(client.recordedHeartbeats).toHaveLength(0);
  });
});
