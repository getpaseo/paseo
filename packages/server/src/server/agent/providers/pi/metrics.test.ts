import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { AgentMetric, AgentStreamEvent } from "../../agent-sdk-types.js";
import { PiRpcAgentClient } from "./agent.js";
import { PiFirstTokenTimer, piReplyStep, piSessionMetrics } from "./metrics.js";
import type { PiAgentMessage } from "./rpc-types.js";
import { FakePi } from "./test-utils/fake-pi.js";

// The fields Pi records on an assistant message, which Paseo's message type leaves out.
function reply(fields: Record<string, unknown> = {}): PiAgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    provider: "anthropic",
    model: "claude-sonnet",
    stopReason: "stop",
    usage: {
      input: 1_000,
      // Reasoning is part of output.
      output: 600,
      reasoning: 200,
      cacheRead: 3_000,
      cacheWrite: 0,
      cost: { total: 0.012 },
    },
    timestamp: 10_000,
    durationMs: 3_000,
    ...fields,
  } as PiAgentMessage;
}

function user(text: string, timestamp: number): PiAgentMessage {
  return { role: "user", content: text, timestamp } as PiAgentMessage;
}

function toolResult(id: string, fields: Record<string, unknown>): PiAgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    ...fields,
  } as PiAgentMessage;
}

function value(metrics: AgentMetric[] | undefined, label: string) {
  return metrics?.find((metric) => metric.label === label)?.value;
}

function createClient(pi: FakePi) {
  return new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
}

type StreamEvent<T extends AgentStreamEvent["type"]> = Extract<AgentStreamEvent, { type: T }>;

function firstEvent<T extends AgentStreamEvent["type"]>(events: AgentStreamEvent[], type: T) {
  return events.find((event): event is StreamEvent<T> => event.type === type);
}

function lastEvent<T extends AgentStreamEvent["type"]>(events: AgentStreamEvent[], type: T) {
  return events.findLast((event): event is StreamEvent<T> => event.type === type);
}

describe("Pi reply steps", () => {
  test("names the served model and thinking level, and ends when the response did", () => {
    expect(
      piReplyStep(reply({ responseModel: "claude-sonnet-4-6", thinkingLevel: "high" }), 400),
    ).toEqual({
      model: "claude-sonnet-4-6 (high)",
      tokens: { input: 1_000, output: 600, cacheRead: 3_000, cacheWrite: 0 },
      costUsd: 0.012,
      durationMs: 3_000,
      ttftMs: 400,
      endedAt: 13_000,
    });
  });

  test("a malformed field costs only that field", () => {
    expect(
      piReplyStep(reply({ thinkingLevel: "off", usage: { input: -1 }, durationMs: "slow" })),
    ).toEqual({
      model: "claude-sonnet",
      tokens: null,
      costUsd: null,
      durationMs: null,
      ttftMs: null,
      endedAt: null,
    });
  });

  test("other messages are not steps", () => {
    expect(piReplyStep(user("hi", 1))).toBeNull();
  });
});

describe("Pi first token timer", () => {
  test("times the first content of each reply", () => {
    const timer = new PiFirstTokenTimer();
    timer.replyStarted(1_000);
    timer.replyUpdated({ type: "start" }, 1_100);
    // An empty delta is not a token.
    timer.replyUpdated({ type: "text_delta", delta: "" }, 1_200);
    timer.replyUpdated({ type: "toolcall_start" }, 1_300);
    timer.replyUpdated({ type: "text_delta", delta: "late" }, 1_400);
    expect(timer.replyEnded()).toBe(300);

    timer.replyStarted(2_000);
    timer.replyUpdated({ type: "thinking_delta", delta: "hmm" }, 2_050);
    expect(timer.replyEnded()).toBe(50);

    // The request going out starts the clock; the reply's start arrives later, with the headers.
    timer.requestSent(5_000);
    timer.replyStarted(8_000);
    timer.replyUpdated({ type: "text_start" }, 8_050);
    expect(timer.replyEnded()).toBe(3_050);

    // A reply whose start was not seen, or that never produced content, is not timed.
    timer.replyUpdated({ type: "text_start" }, 3_000);
    expect(timer.replyEnded()).toBeNull();
    timer.replyStarted(4_000);
    expect(timer.replyEnded()).toBeNull();
  });
});

describe("Pi session metrics", () => {
  test("reports Pi's cumulative totals, the last reply's cache hit and tool calls", () => {
    expect(
      piSessionMetrics(
        {
          tokens: { input: 50_000, output: 4_000, cacheRead: 200_000, cacheWrite: 0 },
          cost: 2.5,
          toolCalls: 12,
        },
        piReplyStep(reply()),
      ),
    ).toEqual([
      { label: "Tokens", value: "50.0K ↑ · 4.0K ↓" },
      { label: "Cache (last reply)", value: "75%", tone: "ok" },
      { label: "Cost", value: "$2.50" },
      { label: "Tool calls", value: "12" },
    ]);
  });

  test("a new session reports nothing", () => {
    expect(piSessionMetrics({ toolCalls: 0 }, null)).toEqual([]);
  });
});

describe("Pi metrics through the session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a completed turn carries its metrics and the session reports its totals", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
    const pi = new FakePi();
    const session = await createClient(pi).createSession({ provider: "pi", cwd: tmpdir() });
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const runtime = pi.latestSession();

    await session.startTurn("fix the build");
    runtime.emit({ type: "agent_start" });
    runtime.emit({ type: "turn_start" });
    // The first reply calls two tools that run in parallel.
    vi.setSystemTime(100_500);
    runtime.emit({ type: "message_start", message: reply({ content: [] }) });
    vi.setSystemTime(100_800);
    runtime.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start" },
    });
    vi.setSystemTime(101_500);
    runtime.emit({
      type: "message_end",
      message: reply({ stopReason: "toolUse", durationMs: 1_000 }),
    });
    runtime.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} });
    vi.setSystemTime(102_000);
    runtime.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} });
    vi.setSystemTime(103_000);
    runtime.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: {} });
    vi.setSystemTime(104_000);
    runtime.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: {} });
    // The final reply.
    runtime.emit({ type: "message_start", message: reply({ content: [] }) });
    vi.setSystemTime(104_100);
    runtime.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "d" },
    });
    vi.setSystemTime(107_000);
    const answer = reply({ responseModel: "claude-sonnet-4-6", thinkingLevel: "high" });
    runtime.emit({ type: "message_end", message: answer });
    runtime.stats = {
      tokens: { input: 2_000, output: 1_200, cacheRead: 6_000, cacheWrite: 0 },
      cost: 0.024,
      toolCalls: 2,
    };
    runtime.finishTurn(answer);

    await expect.poll(() => firstEvent(events, "turn_completed") !== undefined).toBe(true);
    const completed = firstEvent(events, "turn_completed");
    expect(completed?.metrics).toEqual([
      { label: "Model", value: "claude-sonnet-4-6 (high)" },
      // 1,200 output tokens over 4s of requests.
      { label: "Speed", value: "~300 tok/s" },
      { label: "Elapsed", value: "7.0s" },
      { label: "Model time", value: "4.0s" },
      // Tools ran from 101.5s to 104s.
      { label: "Tool time", value: "2.5s" },
      // The first reply's clock starts when the request went out (turn_start, 100.0s), before its
      // headers arrived: 0.8s. The second has no turn_start, so it starts at its message_start:
      // 0.1s.
      { label: "Average TTFT", value: "0.5s" },
      { label: "Steps", value: "2" },
      { label: "Tokens", value: "2.0K ↑ · 1.2K ↓" },
      { label: "Cache", value: "75%", tone: "ok" },
      { label: "Cost", value: "$0.024" },
    ]);
    await expect
      .poll(() => lastEvent(events, "session_metrics_updated"))
      .toMatchObject({
        metrics: [
          { label: "Tokens", value: "2.0K ↑ · 1.2K ↓" },
          { label: "Cache (last reply)", value: "75%", tone: "ok" },
          { label: "Cost", value: "$0.024" },
          { label: "Tool calls", value: "2" },
        ],
      });
  });

  test("a failed turn reports no metrics and leaves none to the next turn", async () => {
    const pi = new FakePi();
    const session = await createClient(pi).createSession({ provider: "pi", cwd: tmpdir() });
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const runtime = pi.latestSession();

    await session.startTurn("first");
    const failed = reply({ stopReason: "error", errorMessage: "overloaded" });
    runtime.emit({ type: "message_end", message: failed });
    runtime.finishTurn(failed);
    await expect.poll(() => firstEvent(events, "turn_failed") !== undefined).toBe(true);

    await session.startTurn("second");
    const answer = reply();
    runtime.emit({ type: "message_end", message: answer });
    runtime.finishTurn(answer);
    await expect.poll(() => firstEvent(events, "turn_completed") !== undefined).toBe(true);
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(value(metrics, "Steps")).toBeUndefined();
    expect(value(metrics, "Tokens")).toBe("1.0K ↑ · 600 ↓");
  });
});

describe("Pi history metrics", () => {
  test("replays each finished turn's metrics after its rows", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((runtime) => {
      runtime.messages = [
        user("first", 9_000),
        reply({
          stopReason: "toolUse",
          durationMs: 1_000,
          content: [
            { type: "toolCall", id: "a", name: "bash", arguments: {} },
            { type: "toolCall", id: "b", name: "bash", arguments: {} },
          ],
        }),
        // Parallel runs, 11s–13s and 12s–14s: 3s of tool time.
        toolResult("a", { timestamp: 13_000, durationMs: 2_000 }),
        toolResult("b", { timestamp: 14_000, durationMs: 2_000 }),
        reply({ timestamp: 14_500, durationMs: 1_500 }),
        user("second", 20_000),
        reply({ stopReason: "aborted", errorMessage: "Request was aborted" }),
      ];
      runtime.stats = {
        tokens: { input: 3_000, output: 1_800, cacheRead: 9_000, cacheWrite: 0 },
        cost: 0.036,
        toolCalls: 2,
      };
    });
    const session = await createClient(pi).resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: { cwd: tmpdir() },
      },
      {},
      undefined,
      { purpose: "history" },
    );
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);

    const sequence = events.map((event) =>
      event.type === "timeline" ? event.item.type : event.type,
    );
    const completedAt = sequence.indexOf("turn_completed");
    expect(sequence.slice(completedAt - 1, completedAt + 2)).toEqual([
      "assistant_message",
      "turn_completed",
      "user_message",
    ]);
    expect(sequence.filter((type) => type === "turn_completed")).toHaveLength(1);
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(value(metrics, "Elapsed")).toBe("7.0s");
    expect(value(metrics, "Model time")).toBe("2.5s");
    expect(value(metrics, "Tool time")).toBe("3.0s");
    // Pi does not record time to first token.
    expect(value(metrics, "Average TTFT")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "session_metrics_updated",
      metrics: [
        { label: "Tokens", value: "3.0K ↑ · 1.8K ↓" },
        { label: "Cache (last reply)", value: "75%", tone: "ok" },
        { label: "Cost", value: "$0.036" },
        { label: "Tool calls", value: "2" },
      ],
    });
  });

  test("a tool result without a recorded duration hides the turn's tool time", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((runtime) => {
      runtime.messages = [
        user("first", 9_000),
        reply({ stopReason: "toolUse" }),
        toolResult("a", { timestamp: 13_000 }),
        reply({ timestamp: 14_000 }),
      ];
    });
    const session = await createClient(pi).resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: { cwd: tmpdir() },
      },
      {},
      undefined,
      { purpose: "history" },
    );
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(value(metrics, "Steps")).toBe("2");
    expect(value(metrics, "Tool time")).toBeUndefined();
  });
});
