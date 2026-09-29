import { V2Timeline } from "./timeline.js";
import type { SessionMessageAssistant } from "@opencode/client";
import { describe, expect, test } from "vitest";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

function collectAssistantText(session: {
  subscribe: (cb: (e: AgentStreamEvent) => void) => () => void;
}) {
  const chunks: string[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      chunks.push(event.item.text);
  });
  return chunks;
}

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

describe("OpenCode v2 token streaming", () => {
  test("emits text and reasoning deltas as they arrive", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    try {
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 3,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "think" },
      });
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 4,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "Hel" },
      });
      harness.push({
        id: "t2",
        created: 5,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "lo" },
      });
      await expect.poll(() => text).toEqual(["Hel", "lo"]);
      expect(reasoning).toEqual(["think"]);
    } finally {
      await session.close();
    }
  });

  test("reports the latest step's context usage against the model's context limit", async () => {
    const harness = new V2Harness();
    harness.info.model = { providerID: "test", id: "model" };
    harness.info.tokens = { input: 900, output: 90, reasoning: 0, cache: { read: 0, write: 0 } };
    harness.info.cost = 0.5;
    harness.api.model.list = async () => ({
      location: harness.info.location,
      data: [
        {
          id: "model",
          modelID: "model",
          providerID: "test",
          name: "Model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 1 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 10000 },
        },
      ],
    });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    const stepEnded = (id: string, input: number) =>
      harness.push({
        id,
        created: 2,
        type: "session.step.ended",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          finish: "tool-calls",
          cost: 0.1,
          tokens: { input, output: 10, reasoning: 5, cache: { read: 1000, write: 20 } },
        },
      });
    try {
      stepEnded("step-1", 100);
      stepEnded("step-2", 300);
      await expect.poll(() => usage.length).toBe(2);
      expect(usage[1]).toEqual({
        inputTokens: 900,
        outputTokens: 90,
        cachedInputTokens: 0,
        totalCostUsd: 0.5,
        contextWindowUsedTokens: 1335,
        contextWindowMaxTokens: 200000,
      });
    } finally {
      await session.close();
    }
  });

  test("deduplicates snapshots before and after deltas using per-type ordinals", () => {
    const timeline = new V2Timeline();
    const text = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    const reasoning = { ...text, type: "reasoning" } as const;
    timeline.startPart(text);
    timeline.startPart(reasoning);
    expect(timeline.delta({ ...text, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    expect(timeline.delta({ ...reasoning, delta: "think" })).toMatchObject({
      item: { text: "think" },
    });
    const snapshot = assistant([
      {
        type: "reasoning",
        text: "think",
        state: { reasoningField: "reasoning_content" },
        time: { created: 2, completed: 2 },
      },
      { type: "text", text: "Hello" },
    ]);
    expect(timeline.messages([snapshot])).toMatchObject([{ item: { text: "lo" } }]);
    expect(timeline.delta({ ...text, delta: "lo" })).toBeNull();
    expect(timeline.messages([snapshot])).toEqual([]);
    expect(timeline.delta({ ...text, delta: "!" })).toMatchObject({ item: { text: "!" } });
    expect(timeline.messages([snapshot])).toEqual([]);
  });

  test("recovers missed fragments from snapshots after reconnect", () => {
    const timeline = new V2Timeline();
    const part = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    timeline.startPart(part);
    expect(timeline.delta({ ...part, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    timeline.resetStreams();
    expect(timeline.delta({ ...part, delta: "!" })).toBeNull();
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toMatchObject([
      { item: { text: "lo!" } },
    ]);
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toEqual([]);
  });

  test("withholds streamed prose during a structured-output turn", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const settle = () => harness.finishExecution();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    const failures: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_failed") failures.push(event);
    });
    try {
      await session.startTurn("answer", {
        outputSchema: { type: "object", properties: { answer: { type: "integer" } } },
      });
      await expect.poll(() => harness.prompts).toEqual(["answer"]);
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 3,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "ignore me",
        },
      });
      // A following reasoning delta is still delivered, so its arrival proves
      // the text delta was seen and suppressed rather than merely not yet read.
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 4,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "thought" },
      });
      await expect.poll(() => reasoning).toEqual(["thought"]);
      expect(text).toEqual([]);
      // A late delta after the structured turn failed must remain suppressed.
      settle();
      await expect.poll(() => failures.length).toBe(1);
      harness.push({
        id: "late",
        created: 5,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "still hidden",
        },
      });
      harness.push({
        id: "r2",
        created: 6,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "done" },
      });
      await expect.poll(() => reasoning).toEqual(["thought", "done"]);
      expect(text).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
