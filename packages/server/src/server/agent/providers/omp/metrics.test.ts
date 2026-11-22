import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentClient } from "./agent.js";
import { ompReplyStep, ompSessionMetrics } from "./metrics.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

// The fields OMP records on an assistant message, which Paseo's message schema leaves untyped.
function reply(fields: Record<string, unknown> = {}): OmpAgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    provider: "anthropic",
    model: "claude-sonnet",
    stopReason: "stop",
    usage: {
      input: 1_000,
      output: 600,
      cacheRead: 3_000,
      cacheWrite: 0,
      cost: { total: 0.012 },
    },
    timestamp: 10_000,
    duration: 3_000,
    ttft: 500,
    completedAt: 13_100,
    ...fields,
  } as OmpAgentMessage;
}

function metric(metrics: { label: string; value: string }[] | undefined, label: string) {
  return metrics?.find((entry) => entry.label === label)?.value;
}

type StreamEvent<T extends AgentStreamEvent["type"]> = Extract<AgentStreamEvent, { type: T }>;

function firstEvent<T extends AgentStreamEvent["type"]>(events: AgentStreamEvent[], type: T) {
  return events.find((event): event is StreamEvent<T> => event.type === type);
}

function lastEvent<T extends AgentStreamEvent["type"]>(events: AgentStreamEvent[], type: T) {
  return events.findLast((event): event is StreamEvent<T> => event.type === type);
}

describe("OMP reply steps", () => {
  test("reads the served model, usage and timing", () => {
    expect(ompReplyStep(reply({ upstreamModel: "claude-sonnet-4-6" }))).toEqual({
      model: "claude-sonnet-4-6",
      tokens: { input: 1_000, output: 600, cacheRead: 3_000, cacheWrite: 0 },
      costUsd: 0.012,
      durationMs: 3_000,
      ttftMs: 500,
      endedAt: 13_100,
    });
  });

  test("a malformed field costs only that field", () => {
    expect(
      ompReplyStep(reply({ ttft: "fast", usage: { input: 1 }, completedAt: undefined })),
    ).toEqual({
      model: "claude-sonnet",
      tokens: null,
      costUsd: null,
      durationMs: 3_000,
      ttftMs: null,
      // Without OMP's completion stamp the response ended when the request did.
      endedAt: 13_000,
    });
  });

  test("other messages are not steps", () => {
    expect(ompReplyStep({ role: "user", content: "hi" })).toBeNull();
  });
});

describe("OMP session metrics", () => {
  test("reports OMP's cumulative totals and the last reply's cache hit", () => {
    expect(
      ompSessionMetrics(
        {
          tokens: { input: 50_000, output: 4_000, cacheRead: 200_000, cacheWrite: 0 },
          cost: 2.5,
          toolCalls: 12,
          premiumRequests: 3,
        },
        ompReplyStep(reply()),
      ),
    ).toEqual([
      { label: "Tokens", value: "50.0K ↑ · 4.0K ↓" },
      { label: "Cache (last reply)", value: "75%", tone: "ok" },
      { label: "Cost", value: "$2.50" },
      { label: "Tool calls", value: "12" },
      { label: "Premium requests", value: "3" },
    ]);
  });

  test("a new session reports nothing", () => {
    expect(ompSessionMetrics({}, null)).toEqual([]);
  });
});

describe("OMP metrics through the session", () => {
  test("a completed turn carries its metrics and the session reports its totals", async () => {
    const runtime = new FakeOmp();
    const client = new OmpAgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession({ provider: "omp", cwd: process.cwd() });
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("fix the build");
    const omp = runtime.latestSession();
    omp.beginTurn();
    omp.acceptPrompt("fix the build");
    const plan = reply({
      stopReason: "toolUse",
      duration: 1_000,
      ttft: 300,
      completedAt: undefined,
    });
    omp.emit({ type: "message_end", message: plan });
    omp.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
    omp.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {} });
    const answer = reply({ upstreamModel: "claude-sonnet-4-6", ttft: 700 });
    omp.emit({ type: "message_end", message: answer });
    omp.stats = {
      tokens: { input: 2_000, output: 1_200, cacheRead: 6_000, cacheWrite: 0 },
      cost: 0.024,
    };
    omp.finishTurn(answer);

    await expect.poll(() => firstEvent(events, "turn_completed")).toBeDefined();
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(metric(metrics, "Model")).toBe("claude-sonnet-4-6");
    // 1,200 output tokens over 4s of requests.
    expect(metric(metrics, "Speed")).toBe("~300 tok/s");
    expect(metric(metrics, "Model time")).toBe("4.0s");
    expect(metric(metrics, "Average TTFT")).toBe("0.5s");
    expect(metric(metrics, "Steps")).toBe("2");
    expect(metric(metrics, "Tokens")).toBe("2.0K ↑ · 1.2K ↓");
    expect(metric(metrics, "Cost")).toBe("$0.024");
    expect(metrics?.some((entry) => entry.label === "Elapsed")).toBe(true);

    await expect
      .poll(() => lastEvent(events, "session_metrics_updated"))
      .toMatchObject({
        metrics: [
          { label: "Tokens", value: "2.0K ↑ · 1.2K ↓" },
          { label: "Cache (last reply)", value: "75%", tone: "ok" },
          { label: "Cost", value: "$0.024" },
        ],
      });
  });

  test("a failed turn reports no metrics and the next turn starts its own", async () => {
    const runtime = new FakeOmp();
    const client = new OmpAgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession({ provider: "omp", cwd: process.cwd() });
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("first");
    const omp = runtime.latestSession();
    omp.beginTurn();
    omp.acceptPrompt("first");
    const failed = reply({ stopReason: "error", errorMessage: "overloaded" });
    omp.emit({ type: "message_end", message: failed });
    omp.finishTurn(failed);
    await expect.poll(() => firstEvent(events, "turn_failed") !== undefined).toBe(true);

    await session.startTurn("second");
    omp.beginTurn();
    omp.acceptPrompt("second", "omp-user-2");
    const answer = reply({ duration: 2_000, ttft: 100 });
    omp.emit({ type: "message_end", message: answer });
    omp.finishTurn(answer);
    await expect.poll(() => firstEvent(events, "turn_completed")).toBeDefined();
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(metric(metrics, "Steps")).toBeUndefined();
    expect(metric(metrics, "TTFT")).toBe("0.1s");
  });
});

describe("OMP history metrics", () => {
  async function sessionFile(messages: Record<string, unknown>[]) {
    const directory = await mkdtemp(join(tmpdir(), "paseo-omp-metrics-"));
    const file = join(directory, "session.jsonl");
    const entries = [
      { type: "session", id: "root", parentId: null },
      ...messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? "root" : `entry-${index - 1}`,
        message,
      })),
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    return file;
  }

  test("replays each finished turn's metrics after its rows", async () => {
    const file = await sessionFile([
      { role: "user", content: "first", timestamp: 9_000 },
      reply({ completedAt: 13_000 }),
      { role: "user", content: "second", timestamp: 20_000 },
      reply({ stopReason: "aborted", errorMessage: "Interrupted" }),
      { role: "user", content: "third", timestamp: 30_000 },
      reply({ stopReason: "toolUse" }),
    ]);
    const handle: AgentPersistenceHandle = {
      provider: "omp",
      sessionId: "history-1",
      nativeHandle: file,
      metadata: { cwd: process.cwd() },
    };
    const client = new OmpAgentClient({ logger: createTestLogger(), runtime: new FakeOmp() });
    const session = await client.resumeSession(handle, undefined, undefined, {
      purpose: "history",
    });
    const events: AgentStreamEvent[] = [];
    try {
      for await (const event of session.streamHistory()) events.push(event);
    } finally {
      await session.close();
    }

    const sequence = events.map((event) =>
      event.type === "timeline" ? event.item.type : event.type,
    );
    expect(sequence.slice(0, 4)).toEqual([
      "user_message",
      "assistant_message",
      "turn_completed",
      "user_message",
    ]);
    expect(sequence.filter((type) => type === "turn_completed")).toHaveLength(1);
    const completed = firstEvent(events, "turn_completed");
    const metrics = completed?.metrics;
    expect(metric(metrics, "Elapsed")).toBe("4.0s");
    expect(metric(metrics, "Speed")).toBe("~200 tok/s");
    // OMP does not record how long tools ran.
    expect(metric(metrics, "Tool time")).toBeUndefined();
  });

  test("a live session restores its session metrics from history", async () => {
    const file = await sessionFile([{ role: "user", content: "first", timestamp: 9_000 }, reply()]);
    const runtime = new FakeOmp();
    runtime.queueSessionSetup((omp) => {
      omp.stats = {
        tokens: { input: 1_000, output: 600, cacheRead: 3_000, cacheWrite: 0 },
        cost: 0.012,
      };
    });
    const client = new OmpAgentClient({ logger: createTestLogger(), runtime });
    const session = await client.resumeSession({
      provider: "omp",
      sessionId: "omp-session-1",
      nativeHandle: file,
      metadata: { cwd: process.cwd() },
    });
    onTestFinished(() => session.close());
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    expect(lastEvent(events, "session_metrics_updated")).toMatchObject({
      metrics: [
        { label: "Tokens", value: "1.0K ↑ · 600 ↓" },
        { label: "Cache (last reply)", value: "75%", tone: "ok" },
        { label: "Cost", value: "$0.012" },
      ],
    });
  });
});
