import type { SessionInfo, SessionMessageInfo, TokenUsageInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentMetric, AgentStreamEvent } from "../../../agent-sdk-types.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { latestTurnMetrics, replayedTurnMetrics, sessionMetrics } from "./metrics.js";

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>;
type Content = Assistant["content"][number];

function tokens(
  input: number,
  output: number,
  { reasoning = 0, read = 0, write = 0 } = {},
): TokenUsageInfo {
  return { input, output, reasoning, cache: { read, write } };
}

function user(id: string, created: number): SessionMessageInfo {
  return { id, type: "user", text: id, time: { created } };
}

function idle(
  id: string,
  created: number,
  outcome: "succeeded" | "failed" = "succeeded",
): SessionMessageInfo {
  return { id, type: "idle", outcome, time: { created } };
}

function step(
  id: string,
  time: { created: number; firstToken?: number; streamed?: number; completed?: number },
  options: {
    tokens?: TokenUsageInfo;
    cost?: number;
    content?: Content[];
    model?: Assistant["model"];
    error?: Assistant["error"];
  } = {},
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: options.model ?? { providerID: "anthropic", id: "claude-sonnet" },
    // The bundled client predates `firstToken`; newer servers send it.
    time: time as Assistant["time"],
    content: options.content ?? [{ type: "text", text: "answer" }],
    tokens: options.tokens ?? tokens(0, 0),
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    ...(options.error ? { error: options.error } : {}),
  };
}

function tool(id: string, time: { created: number; ran?: number; completed?: number }): Content {
  return {
    type: "tool",
    id,
    name: "bash",
    time,
    state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
  };
}

function metric(metrics: AgentMetric[], label: string) {
  return metrics.find((entry) => entry.label === label);
}

describe("OpenCode v2 turn metrics", () => {
  test("a single reply reports its model, speed, timing, tokens, cache and cost", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 1_000),
      step(
        "reply",
        { created: 1_200, firstToken: 1_700, streamed: 3_700, completed: 3_800 },
        {
          tokens: tokens(2_000, 900, { reasoning: 100, read: 6_000, write: 2_000 }),
          cost: 0.0123,
          model: { providerID: "anthropic", id: "claude-sonnet", variant: "high" },
        },
      ),
    ]);
    expect(metrics).toEqual([
      { label: "Model", value: "anthropic/claude-sonnet (high)" },
      // 1,000 generated tokens over the 2s between the first token and the end of the stream.
      { label: "Response", value: "~500 tok/s" },
      // The same tokens over the 2.6s the model ran.
      { label: "Whole turn", value: "~385 tok/s" },
      { label: "Elapsed", value: "2.8s" },
      { label: "Model time", value: "2.6s" },
      { label: "TTFT", value: "0.5s" },
      { label: "Tokens", value: "2.0K ↑ · 1.0K ↓" },
      { label: "Cache", value: "60%", tone: "ok" },
      { label: "Cost", value: "$0.012" },
    ]);
  });

  test("a multi-step turn sums its steps and leaves parallel tool time out of model time", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step(
        "plan",
        { created: 100, firstToken: 300, streamed: 1_100, completed: 4_100 },
        {
          tokens: tokens(1_000, 400, { read: 3_000 }),
          cost: 0.01,
          content: [
            // Two tools run side by side over 1.1s–4.1s; together they took 3s, not 5s.
            tool("a", { created: 900, ran: 1_100, completed: 4_100 }),
            tool("b", { created: 1_000, ran: 2_100, completed: 4_100 }),
          ],
        },
      ),
      step(
        "answer",
        { created: 4_200, firstToken: 4_600, streamed: 5_200, completed: 5_200 },
        { tokens: tokens(500, 600, { read: 4_500 }), cost: 0.02 },
      ),
    ]);
    expect(metric(metrics, "Steps")).toEqual({ label: "Steps", value: "2" });
    expect(metric(metrics, "Elapsed")?.value).toBe("5.2s");
    // (4.0s - 3.0s tools) + 1.0s.
    expect(metric(metrics, "Model time")?.value).toBe("2.0s");
    expect(metric(metrics, "Tool time")?.value).toBe("3.0s");
    // 1,000 generated tokens over 2s of model time.
    expect(metric(metrics, "Whole turn")?.value).toBe("~500 tok/s");
    // The final reply streamed 600 tokens in 0.6s.
    expect(metric(metrics, "Response")?.value).toBe("~1000 tok/s");
    expect(metric(metrics, "Average TTFT")?.value).toBe("0.3s");
    expect(metric(metrics, "Tokens")?.value).toBe("1.5K ↑ · 1.0K ↓");
    expect(metric(metrics, "Cache")).toEqual({ label: "Cache", value: "83%", tone: "ok" });
    expect(metric(metrics, "Cost")?.value).toBe("$0.030");
  });

  test("a final step that called tools reports no response speed", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step(
        "reply",
        { created: 0, firstToken: 100, streamed: 500, completed: 1_000 },
        {
          tokens: tokens(10, 100),
          content: [tool("a", { created: 400, ran: 500, completed: 1_000 })],
        },
      ),
    ]);
    expect(metric(metrics, "Response")).toBeUndefined();
    expect(metric(metrics, "Whole turn")?.value).toBe("~200 tok/s");
    expect(metric(metrics, "Tool time")?.value).toBe("0.5s");
  });

  test("an error reply reports no response speed", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step(
        "reply",
        { created: 0, firstToken: 100, streamed: 500, completed: 500 },
        { tokens: tokens(10, 100), error: { type: "api", message: "overloaded" } },
      ),
    ]);
    expect(metric(metrics, "Response")).toBeUndefined();
  });

  test("one step with a bad timestamp hides turn timing instead of showing a partial total", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step("first", { created: 100, completed: 1_100 }, { tokens: tokens(10, 100) }),
      // A tool that ends after its step ended is not a believable interval.
      step(
        "second",
        { created: 1_200, completed: 2_200 },
        {
          tokens: tokens(10, 100),
          content: [tool("a", { created: 1_300, ran: 1_400, completed: 9_000 })],
        },
      ),
    ]);
    expect(metric(metrics, "Model time")).toBeUndefined();
    expect(metric(metrics, "Tool time")).toBeUndefined();
    expect(metric(metrics, "Whole turn")).toBeUndefined();
    // Elapsed and token totals do not depend on the bad interval.
    expect(metric(metrics, "Elapsed")?.value).toBe("2.2s");
    expect(metric(metrics, "Tokens")?.value).toBe("20 ↑ · 200 ↓");
  });

  test("servers without first-token stamps report no TTFT or response speed", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step("reply", { created: 0, streamed: 900, completed: 1_000 }, { tokens: tokens(10, 100) }),
    ]);
    expect(metric(metrics, "TTFT")).toBeUndefined();
    expect(metric(metrics, "Response")).toBeUndefined();
    expect(metric(metrics, "Whole turn")?.value).toBe("~100 tok/s");
  });

  test("an implausible rate is hidden", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step(
        "reply",
        { created: 0, firstToken: 1, streamed: 2, completed: 2 },
        { tokens: tokens(10, 100_000) },
      ),
    ]);
    expect(metric(metrics, "Response")).toBeUndefined();
    expect(metric(metrics, "Whole turn")).toBeUndefined();
  });

  test("a turn still running reports nothing", () => {
    expect(
      latestTurnMetrics([
        user("prompt", 0),
        step("reply", { created: 0 }, { tokens: tokens(1, 1) }),
      ]),
    ).toEqual([]);
  });

  test("a turn without tokens or cost leaves those metrics out", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step("reply", { created: 0, completed: 1_000 }),
    ]);
    expect(metrics.map((entry) => entry.label)).toEqual(["Model", "Elapsed", "Model time"]);
  });

  test("a steered prompt stays in the turn the idle marker closes", () => {
    const metrics = latestTurnMetrics([
      user("prompt", 0),
      step("first", { created: 100, completed: 1_000 }, { tokens: tokens(10, 100) }),
      user("steer", 500),
      step("second", { created: 1_100, completed: 2_000 }, { tokens: tokens(10, 100) }),
      idle("idle", 2_000),
    ]);
    expect(metric(metrics, "Steps")?.value).toBe("2");
    expect(metric(metrics, "Elapsed")?.value).toBe("2.0s");
  });
});

describe("OpenCode v2 replayed turn metrics", () => {
  test("keys each successful turn by the message its metrics follow", () => {
    const replayed = replayedTurnMetrics([
      user("first", 0),
      step("first-reply", { created: 100, completed: 1_000 }, { tokens: tokens(10, 100) }),
      idle("first-idle", 1_000),
      user("second", 2_000),
      step("second-reply", { created: 2_100, completed: 2_500 }, { tokens: tokens(10, 100) }),
      idle("second-idle", 2_500, "failed"),
      user("third", 3_000),
      step("third-reply", { created: 3_100 }),
    ]);
    expect([...replayed.keys()]).toEqual(["first-idle"]);
    expect(metric(replayed.get("first-idle")!, "Elapsed")?.value).toBe("1.0s");
  });

  test("sessions without idle markers end a turn at the next prompt", () => {
    const replayed = replayedTurnMetrics([
      user("first", 0),
      step("first-reply", { created: 100, completed: 1_000 }, { tokens: tokens(10, 100) }),
      user("second", 2_000),
      step("second-reply", { created: 2_100, completed: 2_500 }, { tokens: tokens(10, 100) }),
    ]);
    expect([...replayed.keys()]).toEqual(["first-reply", "second-reply"]);
  });
});

describe("OpenCode v2 session metrics", () => {
  const info: Pick<SessionInfo, "tokens" | "cost"> = {
    tokens: tokens(40_000, 3_000, { reasoning: 500, read: 90_000 }),
    cost: 1.234,
  };

  test("reports cumulative session totals and the cache hit of the last reply", () => {
    expect(
      sessionMetrics(info, [
        user("prompt", 0),
        step("old", { created: 1, completed: 2 }, { tokens: tokens(1_000, 10, { read: 0 }) }),
        step("last", { created: 3, completed: 4 }, { tokens: tokens(100, 10, { read: 900 }) }),
        step("running", { created: 5 }),
      ]),
    ).toEqual([
      { label: "Tokens", value: "40.0K ↑ · 3.5K ↓" },
      { label: "Cache (last reply)", value: "90%", tone: "ok" },
      { label: "Cost", value: "$1.23" },
    ]);
  });

  test("a new session reports nothing", () => {
    expect(sessionMetrics({ tokens: tokens(0, 0), cost: 0 }, [])).toEqual([]);
  });
});

describe("OpenCode v2 metrics through the session", () => {
  function answeredHarness() {
    const harness = new V2Harness();
    harness.info.tokens = tokens(2_000, 1_000, { read: 8_000 });
    harness.info.cost = 0.5;
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push(
        user("prompt", 1_000),
        step(
          "reply",
          { created: 1_000, firstToken: 1_500, streamed: 2_500, completed: 3_000 },
          { tokens: tokens(2_000, 1_000, { read: 8_000 }), cost: 0.5 },
        ),
        idle("idle", 3_000),
      );
    };
    return harness;
  }

  test("a completed turn carries its metrics and the session reports its totals", async () => {
    const harness = answeredHarness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.run("answer");
      const completed = events.find((event) => event.type === "turn_completed");
      expect(completed).toMatchObject({
        metrics: expect.arrayContaining([
          { label: "Model", value: "anthropic/claude-sonnet" },
          { label: "Elapsed", value: "2.0s" },
          { label: "Response", value: "~1000 tok/s" },
        ]),
      });
      const sessionUpdates = events.filter((event) => event.type === "session_metrics_updated");
      expect(sessionUpdates.at(-1)).toMatchObject({
        metrics: [
          { label: "Tokens", value: "2.0K ↑ · 1.0K ↓" },
          { label: "Cache (last reply)", value: "80%", tone: "ok" },
          { label: "Cost", value: "$0.500" },
        ],
      });
      // Reconciling unchanged state does not repeat the same session metrics.
      expect(new Set(sessionUpdates.map((event) => JSON.stringify(event))).size).toBe(
        sessionUpdates.length,
      );
    } finally {
      await session.close();
    }
  });

  test("history replays each turn's metrics after its rows, then the session metrics", async () => {
    const harness = answeredHarness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.run("answer");
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history.map((event) => event.type)).toEqual([
        "timeline",
        "timeline",
        "turn_completed",
        "session_metrics_updated",
      ]);
      expect(history[2]).toMatchObject({
        metrics: expect.arrayContaining([{ label: "Elapsed", value: "2.0s" }]),
      });
      expect(history[3]).toMatchObject({
        metrics: expect.arrayContaining([{ label: "Cost", value: "$0.500" }]),
      });
    } finally {
      await session.close();
    }
  });

  test("history of a session with no turns replays nothing", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("history replays without session metrics when the session info is unavailable", async () => {
    const harness = answeredHarness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.run("answer");
      harness.sessionGetError = new Error("session lookup failed");
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history.map((event) => event.type)).toEqual([
        "timeline",
        "timeline",
        "turn_completed",
      ]);
    } finally {
      await session.close();
    }
  });
});
