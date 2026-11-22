import { describe, expect, test } from "vitest";
import { createSessionMetricsReporter } from "./metrics.js";
import {
  type MeasuredStep,
  measuredTurnMetrics,
  ReplayedTurns,
  type TurnMessageReader,
  TurnMeter,
} from "./turn-metrics.js";

function step(overrides: Partial<MeasuredStep> = {}): MeasuredStep {
  return {
    model: "claude-sonnet",
    tokens: { input: 1_000, output: 500, cacheRead: 3_000, cacheWrite: 0 },
    costUsd: 0.01,
    durationMs: 2_000,
    ttftMs: 400,
    endedAt: null,
    ...overrides,
  };
}

describe("measured turn metrics", () => {
  test("a single step reports model, speed, timing, tokens, cache and cost", () => {
    expect(
      measuredTurnMetrics({ steps: [step()], startedAt: 1_000, endedAt: 3_500, toolMs: null }),
    ).toEqual([
      { label: "Model", value: "claude-sonnet" },
      { label: "Speed", value: "~250 tok/s" },
      { label: "Elapsed", value: "2.5s" },
      { label: "Model time", value: "2.0s" },
      { label: "TTFT", value: "0.4s" },
      { label: "Tokens", value: "1.0K ↑ · 500 ↓" },
      { label: "Cache", value: "75%", tone: "ok" },
      { label: "Cost", value: "$0.010" },
    ]);
  });

  test("several steps sum, average TTFT, count steps and name the last model", () => {
    const metrics = measuredTurnMetrics({
      steps: [
        step({ model: "first", ttftMs: 200 }),
        step({ model: "second", durationMs: 3_000, ttftMs: 600, costUsd: 0.02 }),
      ],
      startedAt: 0,
      endedAt: 9_000,
      toolMs: 3_500,
    });
    expect(metrics).toEqual([
      { label: "Model", value: "second" },
      // 1,000 output tokens over 5s of requests.
      { label: "Speed", value: "~200 tok/s" },
      { label: "Elapsed", value: "9.0s" },
      { label: "Model time", value: "5.0s" },
      { label: "Tool time", value: "3.5s" },
      { label: "Average TTFT", value: "0.4s" },
      { label: "Steps", value: "2" },
      { label: "Tokens", value: "2.0K ↑ · 1.0K ↓" },
      { label: "Cache", value: "75%", tone: "ok" },
      { label: "Cost", value: "$0.030" },
    ]);
  });

  test("a step missing a value hides the totals that need it", () => {
    const metrics = measuredTurnMetrics({
      steps: [step(), step({ durationMs: null, ttftMs: null, costUsd: null, tokens: null })],
      startedAt: null,
      endedAt: 5_000,
      toolMs: null,
    });
    expect(metrics).toEqual([
      { label: "Model", value: "claude-sonnet" },
      { label: "Steps", value: "2" },
    ]);
  });

  test("requests shorter than 100ms report no speed", () => {
    const metrics = measuredTurnMetrics({
      steps: [
        step({ durationMs: 99, tokens: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 } }),
      ],
      startedAt: null,
      endedAt: null,
      toolMs: null,
    });
    expect(metrics.find((metric) => metric.label === "Speed")).toBeUndefined();
  });

  test("a turn without steps reports nothing", () => {
    expect(measuredTurnMetrics({ steps: [], startedAt: 0, endedAt: 1, toolMs: 0 })).toEqual([]);
  });
});

describe("turn meter", () => {
  test("counts parallel tool runs once", () => {
    const meter = new TurnMeter();
    meter.begin(1_000);
    meter.toolStarted("a", 2_000);
    meter.toolStarted("b", 2_500);
    meter.toolEnded("a", 4_000);
    meter.toolEnded("b", 3_000);
    // A tool whose start was never seen adds nothing.
    meter.toolEnded("unknown", 4_500);
    meter.step(step({ endedAt: 6_000 }), 6_000);
    expect(meter.finish(7_000)).toEqual({
      steps: [step({ endedAt: 6_000 })],
      startedAt: 1_000,
      endedAt: 7_000,
      toolMs: 2_000,
    });
  });

  test("a turn begun again starts empty, and one it never saw begin starts at its first event", () => {
    const meter = new TurnMeter();
    meter.begin(0);
    meter.step(step(), 5);
    meter.begin(10);
    expect(meter.finish(20)).toEqual({ steps: [], startedAt: 10, endedAt: 20, toolMs: null });
    meter.reset();
    meter.toolStarted("a", 30);
    meter.toolEnded("a", 40);
    meter.step(step(), 45);
    expect(meter.finish(50)).toMatchObject({ startedAt: 30, endedAt: 50, toolMs: 10 });
  });
});

type Message =
  | { role: "user"; at: number }
  | { role: "assistant"; step: MeasuredStep; final: boolean; endedOnTools?: boolean }
  | { role: "tool"; run: [number, number] | null }
  | { role: "note" };

const reader: TurnMessageReader<Message> = {
  prompt: (message) => (message.role === "user" ? { startedAt: message.at } : null),
  reply: (message) =>
    message.role === "assistant"
      ? { step: message.step, final: message.final, endedOnTools: message.endedOnTools }
      : null,
  toolRun: (message) => (message.role === "tool" ? message.run : undefined),
};

function replay(messages: Message[]) {
  const turns = new ReplayedTurns(reader);
  const out: Array<{ before: number; values: string[]; labels?: string[] }> = [];
  messages.forEach((message, index) => {
    const metrics = turns.observe(message);
    if (metrics.length) out.push({ before: index, values: metrics.map((m) => m.value) });
  });
  const last = turns.end();
  if (last.length)
    out.push({
      before: messages.length,
      values: last.map((m) => m.value),
      labels: last.map((m) => m.label),
    });
  return { out, lastReply: turns.lastReply };
}

describe("replayed turns", () => {
  test("each finished turn's metrics come before the prompt that follows it", () => {
    const first = step({ endedAt: 3_000, model: "first" });
    const second = step({ endedAt: 12_000, model: "second", ttftMs: null, costUsd: null });
    const { out, lastReply } = replay([
      { role: "user", at: 1_000 },
      { role: "assistant", step: step({ endedAt: 2_000 }), final: false },
      // Parallel runs, 2.0s–2.5s and 2.25s–3.0s: 1.0s of tool time, not 1.25s.
      { role: "tool", run: [2_000, 2_500] },
      { role: "tool", run: [2_250, 3_000] },
      { role: "note" },
      { role: "assistant", step: first, final: true },
      { role: "user", at: 10_000 },
      { role: "assistant", step: second, final: true },
    ]);
    expect(out).toEqual([
      {
        before: 6,
        values: [
          "first",
          "~250 tok/s",
          "2.0s",
          "4.0s",
          "1.0s",
          "0.4s",
          "2",
          "2.0K ↑ · 1.0K ↓",
          "75%",
          "$0.020",
        ],
      },
      {
        before: 8,
        values: ["second", "~250 tok/s", "2.0s", "2.0s", "1.0K ↑ · 500 ↓", "75%"],
        labels: ["Model", "Speed", "Elapsed", "Model time", "Tokens", "Cache"],
      },
    ]);
    expect(lastReply).toBe(second);
  });

  test("a turn that did not finish, or whose tool time was not recorded, says so", () => {
    const { out } = replay([
      { role: "user", at: 0 },
      { role: "assistant", step: step({ endedAt: 1_000 }), final: false },
      { role: "user", at: 2_000 },
      { role: "assistant", step: step({ endedAt: 4_000 }), final: false },
      { role: "tool", run: null },
      { role: "assistant", step: step({ endedAt: 5_000 }), final: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.labels).not.toContain("Tool time");
    expect(out[0]!.values[out[0]!.labels!.indexOf("Elapsed")]).toBe("3.0s");
  });
});

describe("replayed turns after a turn that ended on tools", () => {
  test("claims no total for a turn the transcript cannot tell from a steered one, and none for the turn before it", () => {
    const { out } = replay([
      { role: "user", at: 0 },
      { role: "assistant", step: step({ endedAt: 1_000 }), final: false, endedOnTools: true },
      { role: "tool", run: [1_000, 1_500] },
      // Live, this prompt steered the turn above, so one turn spans both replies. After a
      // stop it would have begun another. The transcript reads the same either way.
      { role: "user", at: 2_000 },
      { role: "assistant", step: step({ endedAt: 3_000 }), final: true },
      { role: "user", at: 4_000 },
      { role: "assistant", step: step({ endedAt: 5_000 }), final: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.before).toBe(7);
    expect(out[0]!.labels).toContain("Elapsed");
  });
});

describe("replayed turns after steers queued together", () => {
  test("every prompt queued behind a turn that ended on tools shares its doubt", () => {
    const { out } = replay([
      { role: "user", at: 0 },
      { role: "assistant", step: step({ endedAt: 1_000 }), final: false, endedOnTools: true },
      { role: "tool", run: [1_000, 1_500] },
      { role: "user", at: 2_000 },
      { role: "user", at: 2_100 },
      { role: "assistant", step: step({ endedAt: 3_000 }), final: true },
    ]);
    expect(out).toEqual([]);
  });
});

describe("session metrics reporter", () => {
  test("reports only changes, starting from nothing reported", () => {
    const reported: unknown[] = [];
    const report = createSessionMetricsReporter((metrics) => reported.push(metrics));
    report([]);
    report([{ label: "Cost", value: "$1.00" }]);
    report([{ label: "Cost", value: "$1.00" }]);
    report([]);
    report([{ label: "Cost", value: "$1.00" }]);
    expect(reported).toEqual([
      [{ label: "Cost", value: "$1.00" }],
      [],
      [{ label: "Cost", value: "$1.00" }],
    ]);
  });
});
