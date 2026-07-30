import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  VoiceLiveRouteRequest,
  VoiceLiveRouteResponse,
} from "@getpaseo/protocol/live-voice-routing";
import { LiveVoiceRouteBroker } from "./live-voice-route-broker.js";

const HOST_AGENT_ID = "voice-host-1";
const LIVE_SESSION_ID = "live-session-1";

function createHarness(options: { timeoutMs?: number } = {}) {
  const sourceKey = {};
  const requests: VoiceLiveRouteRequest[] = [];
  const broker = new LiveVoiceRouteBroker({
    defaultTimeoutMs: options.timeoutMs ?? 100,
    createRequestId: () => "route-request-1",
  });
  const unregister = broker.register({
    hostAgentId: HOST_AGENT_ID,
    liveSessionId: LIVE_SESSION_ID,
    sourceKey,
    send: (request) => {
      requests.push(request);
    },
  });
  return { broker, requests, sourceKey, unregister };
}

function hostsResponse(
  requestId: string,
  overrides: Partial<VoiceLiveRouteResponse["payload"]> = {},
): VoiceLiveRouteResponse {
  return {
    type: "voice.live.route.response",
    payload: {
      requestId,
      liveSessionId: LIVE_SESSION_ID,
      ok: true,
      result: {
        kind: "list_hosts",
        hosts: [
          {
            serverId: "server-b",
            label: "Desktop",
            hostname: "desktop",
            version: "0.3.0",
            online: true,
            toolExecutionSupported: true,
          },
        ],
      },
      ...overrides,
    } as VoiceLiveRouteResponse["payload"],
  };
}

describe("LiveVoiceRouteBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes through the exact registered owner and resolves its correlated response", async () => {
    const { broker, requests, sourceKey } = createHarness();

    const resultPromise = broker.execute(HOST_AGENT_ID, { kind: "list_hosts" });

    expect(requests).toEqual([
      {
        type: "voice.live.route.request",
        requestId: "route-request-1",
        liveSessionId: LIVE_SESSION_ID,
        operation: { kind: "list_hosts" },
      },
    ]);
    expect(broker.getPendingRequestCount()).toBe(1);
    expect(broker.receiveResponse(hostsResponse("route-request-1"), sourceKey)).toBe(true);
    await expect(resultPromise).resolves.toEqual(hostsResponse("route-request-1").payload.result);
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  it("ignores a valid response from another socket until the exact owner responds", async () => {
    const { broker, sourceKey } = createHarness();
    const resultPromise = broker.execute(HOST_AGENT_ID, { kind: "list_hosts" });

    expect(broker.receiveResponse(hostsResponse("route-request-1"), {})).toBe(false);
    expect(broker.getPendingRequestCount()).toBe(1);
    expect(broker.receiveResponse(hostsResponse("route-request-1"), sourceKey)).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({ kind: "list_hosts" });
  });

  it("ignores wrong-call and late responses", async () => {
    const { broker, sourceKey } = createHarness();
    const resultPromise = broker.execute(HOST_AGENT_ID, { kind: "list_hosts" });

    expect(
      broker.receiveResponse(
        hostsResponse("route-request-1", { liveSessionId: "another-call" }),
        sourceKey,
      ),
    ).toBe(false);
    expect(broker.receiveResponse(hostsResponse("route-request-1"), sourceKey)).toBe(true);
    await resultPromise;
    expect(broker.receiveResponse(hostsResponse("route-request-1"), sourceKey)).toBe(false);
  });

  it("rejects every pending request when the call unregisters", async () => {
    const { broker, unregister } = createHarness();
    const resultPromise = broker.execute(HOST_AGENT_ID, {
      kind: "execute_tool",
      targetServerId: "server-b",
      toolName: "list_agents",
      arguments: {},
    });

    unregister();

    await expect(resultPromise).rejects.toThrow(
      "The Live Voice call closed before its routed request completed.",
    );
    expect(broker.getPendingRequestCount()).toBe(0);
    expect(broker.isRegisteredHost(HOST_AGENT_ID)).toBe(false);
  });

  it("rejects a route when its owning source returns a structured error", async () => {
    const { broker, sourceKey } = createHarness();
    const resultPromise = broker.execute(HOST_AGENT_ID, { kind: "list_hosts" });

    broker.receiveResponse(
      {
        type: "voice.live.route.response",
        payload: {
          requestId: "route-request-1",
          liveSessionId: LIVE_SESSION_ID,
          ok: false,
          error: {
            code: "target_offline",
            message: "The selected host is offline.",
            retryable: true,
          },
        },
      },
      sourceKey,
    );

    await expect(resultPromise).rejects.toThrow("The selected host is offline.");
  });

  it("times out without accepting a later response", async () => {
    vi.useFakeTimers();
    const { broker, sourceKey } = createHarness({ timeoutMs: 10 });
    const resultPromise = broker.execute(HOST_AGENT_ID, { kind: "list_hosts" });
    const rejection = expect(resultPromise).rejects.toThrow(
      "Timed out waiting for the owning client to route this request.",
    );

    await vi.advanceTimersByTimeAsync(11);

    await rejection;
    expect(broker.getPendingRequestCount()).toBe(0);
    expect(broker.receiveResponse(hostsResponse("route-request-1"), sourceKey)).toBe(false);
  });

  it("removes a pending request when sending to the owner fails", async () => {
    const sourceKey = {};
    const broker = new LiveVoiceRouteBroker({ createRequestId: () => "route-request-1" });
    broker.register({
      hostAgentId: HOST_AGENT_ID,
      liveSessionId: LIVE_SESSION_ID,
      sourceKey,
      send: () => {
        throw new Error("socket closed");
      },
    });

    await expect(broker.execute(HOST_AGENT_ID, { kind: "list_hosts" })).rejects.toThrow(
      "Could not send the Live Voice route request: socket closed",
    );
    expect(broker.getPendingRequestCount()).toBe(0);
  });
});
