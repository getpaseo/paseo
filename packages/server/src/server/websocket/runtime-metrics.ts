import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";

export interface WebSocketRuntimeCounters {
  connectedAwaitingHello: number;
  helloResumed: number;
  helloNew: number;
  pendingDisconnected: number;
  sessionDisconnectedWaitingReconnect: number;
  sessionSocketDisconnectedAttached: number;
  sessionCleanup: number;
  validationFailed: number;
  binaryBeforeHelloRejected: number;
  pendingMessageRejectedBeforeHello: number;
  missingConnectionForMessage: number;
  unexpectedHelloOnActiveConnection: number;
  relayExternalSocketAttached: number;
  originRejected: number;
  hostRejected: number;
}

export interface WebSocketRuntimeMetricsSnapshot {
  windowMs: number;
  counters: WebSocketRuntimeCounters;
  inboundMessageTypesTop: Array<[string, number]>;
  inboundSessionRequestTypesTop: Array<[string, number]>;
  outboundMessageTypesTop: Array<[string, number]>;
  outboundSessionMessageTypesTop: Array<[string, number]>;
  outboundAgentStreamTypesTop: Array<[string, number]>;
  outboundAgentStreamAgentsTop: Array<[string, number]>;
  outboundBinaryFrameTypesTop: Array<[string, number]>;
  bufferedAmount: {
    p95: number;
    max: number;
  };
  latency: Array<{
    type: string;
    count: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    totalMs: number;
  }>;
}

type Clock = () => number;

export class WebSocketRuntimeMetricsWindow {
  private windowStartedAt: number;
  private readonly counters: WebSocketRuntimeCounters = createRuntimeCounters();
  private readonly inboundMessageCounts = new Map<string, number>();
  private readonly inboundSessionRequestCounts = new Map<string, number>();
  private readonly outboundMessageCounts = new Map<string, number>();
  private readonly outboundSessionMessageCounts = new Map<string, number>();
  private readonly outboundAgentStreamCounts = new Map<string, number>();
  private readonly outboundAgentStreamByAgentCounts = new Map<string, number>();
  private readonly outboundBinaryFrameCounts = new Map<string, number>();
  private readonly bufferedAmountSamples: number[] = [];
  private readonly requestLatencies = new Map<string, number[]>();

  constructor(private readonly clock: Clock = Date.now) {
    this.windowStartedAt = this.clock();
  }

  incrementCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.counters[counter] += 1;
  }

  recordInboundMessage(type: string): void {
    incrementCount(this.inboundMessageCounts, type);
  }

  recordInboundSessionRequest(type: string): void {
    incrementCount(this.inboundSessionRequestCounts, type);
  }

  recordOutboundMessage(message: WSOutboundMessage, bufferedAmount?: number): void {
    if (message.type !== "session") {
      incrementCount(this.outboundMessageCounts, message.type);
      this.recordBufferedAmount(bufferedAmount);
      return;
    }

    incrementCount(this.outboundMessageCounts, "session_message");
    incrementCount(this.outboundSessionMessageCounts, message.message.type);

    if (message.message.type === "agent_stream") {
      this.recordOutboundAgentStreamMessage(message.message.payload);
    }

    this.recordBufferedAmount(bufferedAmount);
  }

  recordOutboundBinaryFrame(bufferedAmount?: number): void {
    incrementCount(this.outboundBinaryFrameCounts, "binary");
    this.recordBufferedAmount(bufferedAmount);
  }

  recordRequestLatency(type: string, durationMs: number): void {
    let latencies = this.requestLatencies.get(type);
    if (!latencies) {
      latencies = [];
      this.requestLatencies.set(type, latencies);
    }
    latencies.push(durationMs);
  }

  snapshotAndReset(): WebSocketRuntimeMetricsSnapshot {
    const now = this.clock();
    const snapshot: WebSocketRuntimeMetricsSnapshot = {
      windowMs: Math.max(0, now - this.windowStartedAt),
      counters: { ...this.counters },
      inboundMessageTypesTop: getTopCounts(this.inboundMessageCounts, 12),
      inboundSessionRequestTypesTop: getTopCounts(this.inboundSessionRequestCounts, 20),
      outboundMessageTypesTop: getTopCounts(this.outboundMessageCounts, 12),
      outboundSessionMessageTypesTop: getTopCounts(this.outboundSessionMessageCounts, 20),
      outboundAgentStreamTypesTop: getTopCounts(this.outboundAgentStreamCounts, 20),
      outboundAgentStreamAgentsTop: getTopCounts(this.outboundAgentStreamByAgentCounts, 20),
      outboundBinaryFrameTypesTop: getTopCounts(this.outboundBinaryFrameCounts, 12),
      bufferedAmount: this.computeBufferedAmountStats(),
      latency: this.computeLatencyStats(),
    };

    this.reset(now);
    return snapshot;
  }

  private recordOutboundAgentStreamMessage(
    payload: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"],
  ): void {
    const { agentId, event } = payload;
    const eventType = event.type === "timeline" ? `timeline:${event.item.type}` : event.type;
    incrementCount(this.outboundAgentStreamCounts, eventType);
    incrementCount(this.outboundAgentStreamByAgentCounts, agentId);
  }

  private recordBufferedAmount(bufferedAmount: number | undefined): void {
    if (typeof bufferedAmount !== "number") {
      return;
    }
    this.bufferedAmountSamples.push(bufferedAmount);
  }

  private computeLatencyStats(): WebSocketRuntimeMetricsSnapshot["latency"] {
    const stats: WebSocketRuntimeMetricsSnapshot["latency"] = [];
    for (const [type, latencies] of this.requestLatencies) {
      if (latencies.length === 0) continue;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const count = sortedLatencies.length;
      const minMs = Math.round(sortedLatencies[0]);
      const maxMs = Math.round(sortedLatencies[count - 1]);
      const p50Ms = Math.round(sortedLatencies[Math.floor(count / 2)]);
      const totalMs = Math.round(sortedLatencies.reduce((sum, value) => sum + value, 0));
      stats.push({ type, count, minMs, maxMs, p50Ms, totalMs });
    }
    stats.sort((a, b) => b.totalMs - a.totalMs);
    return stats.slice(0, 15);
  }

  private computeBufferedAmountStats(): WebSocketRuntimeMetricsSnapshot["bufferedAmount"] {
    if (this.bufferedAmountSamples.length === 0) {
      return { p95: 0, max: 0 };
    }

    const samples = [...this.bufferedAmountSamples].sort((a, b) => a - b);
    const p95Index = Math.ceil(samples.length * 0.95) - 1;
    return {
      p95: samples[p95Index] ?? 0,
      max: samples[samples.length - 1] ?? 0,
    };
  }

  private reset(windowStartedAt: number): void {
    for (const counter of Object.keys(this.counters) as Array<keyof WebSocketRuntimeCounters>) {
      this.counters[counter] = 0;
    }
    this.inboundMessageCounts.clear();
    this.inboundSessionRequestCounts.clear();
    this.outboundMessageCounts.clear();
    this.outboundSessionMessageCounts.clear();
    this.outboundAgentStreamCounts.clear();
    this.outboundAgentStreamByAgentCounts.clear();
    this.outboundBinaryFrameCounts.clear();
    this.bufferedAmountSamples.length = 0;
    this.requestLatencies.clear();
    this.windowStartedAt = windowStartedAt;
  }
}

function createRuntimeCounters(): WebSocketRuntimeCounters {
  return {
    connectedAwaitingHello: 0,
    helloResumed: 0,
    helloNew: 0,
    pendingDisconnected: 0,
    sessionDisconnectedWaitingReconnect: 0,
    sessionSocketDisconnectedAttached: 0,
    sessionCleanup: 0,
    validationFailed: 0,
    binaryBeforeHelloRejected: 0,
    pendingMessageRejectedBeforeHello: 0,
    missingConnectionForMessage: 0,
    unexpectedHelloOnActiveConnection: 0,
    relayExternalSocketAttached: 0,
    originRejected: 0,
    hostRejected: 0,
  };
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function getTopCounts(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
