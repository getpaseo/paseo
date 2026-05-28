import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";
import { wrapSessionMessage } from "../messages.js";
import { WebSocketRuntimeMetricsWindow } from "./runtime-metrics.js";

function createMetricsWindow(): {
  metrics: WebSocketRuntimeMetricsWindow;
  advanceClock(ms: number): void;
} {
  let now = 1_000;
  return {
    metrics: new WebSocketRuntimeMetricsWindow(() => now),
    advanceClock(ms: number) {
      now += ms;
    },
  };
}

function agentStreamMessage(params: {
  agentId: string;
  event: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"];
}): WSOutboundMessage {
  return wrapSessionMessage({
    type: "agent_stream",
    payload: {
      agentId: params.agentId,
      event: params.event,
      timestamp: "2026-04-17T00:00:00.000Z",
    },
  });
}

describe("WebSocketRuntimeMetricsWindow", () => {
  it("records outbound message type counts in the runtime metrics window", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      wrapSessionMessage({
        type: "status",
        payload: {
          status: "ok",
          message: "ready",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage({ type: "pong" }, 0);

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.outboundMessageTypesTop).toEqual([
      ["session_message", 2],
      ["pong", 1],
    ]);
    expect(snapshot.outboundSessionMessageTypesTop).toEqual([
      ["agent_stream", 1],
      ["status", 1],
    ]);
  });

  it("records agent_stream subtypes and top agents", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "hello" },
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "reasoning", text: "thinking" },
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-2",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "there" },
        },
      }),
      0,
    );

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.outboundAgentStreamTypesTop).toEqual([
      ["timeline:assistant_message", 2],
      ["timeline:reasoning", 1],
      ["turn_completed", 1],
    ]);
    expect(snapshot.outboundAgentStreamAgentsTop).toEqual([
      ["agent-1", 3],
      ["agent-2", 1],
    ]);
  });

  it("records bufferedAmount p95 and max from samples taken after send", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundMessage(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
      0,
    );
    metrics.recordOutboundMessage(
      wrapSessionMessage({
        type: "status",
        payload: { status: "ok" },
      }),
      10,
    );
    metrics.recordOutboundMessage({ type: "pong" }, 50);
    metrics.recordOutboundBinaryFrame(100);

    const snapshot = metrics.snapshotAndReset();

    expect(snapshot.bufferedAmount).toEqual({
      p95: 100,
      max: 100,
    });
  });

  it("counts binary frames without decoding", () => {
    const { metrics } = createMetricsWindow();

    metrics.recordOutboundBinaryFrame(24);

    const snapshot = metrics.snapshotAndReset();
    expect(snapshot.outboundBinaryFrameTypesTop).toEqual([["binary", 1]]);
  });

  it("resets the runtime window after producing a snapshot", () => {
    const { metrics, advanceClock } = createMetricsWindow();
    metrics.incrementCounter("helloNew");
    metrics.recordInboundMessage("session");
    metrics.recordInboundSessionRequest("send");
    metrics.recordRequestLatency("send", 12.4);
    advanceClock(250);

    const firstSnapshot = metrics.snapshotAndReset();
    const secondSnapshot = metrics.snapshotAndReset();

    expect(firstSnapshot.windowMs).toBe(250);
    expect(firstSnapshot.counters.helloNew).toBe(1);
    expect(firstSnapshot.inboundMessageTypesTop).toEqual([["session", 1]]);
    expect(firstSnapshot.inboundSessionRequestTypesTop).toEqual([["send", 1]]);
    expect(firstSnapshot.latency).toEqual([
      {
        type: "send",
        count: 1,
        minMs: 12,
        maxMs: 12,
        p50Ms: 12,
        totalMs: 12,
      },
    ]);
    expect(secondSnapshot.windowMs).toBe(0);
    expect(secondSnapshot.counters.helloNew).toBe(0);
    expect(secondSnapshot.inboundMessageTypesTop).toEqual([]);
    expect(secondSnapshot.inboundSessionRequestTypesTop).toEqual([]);
    expect(secondSnapshot.latency).toEqual([]);
  });
});
