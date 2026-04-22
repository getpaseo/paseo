import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import {
  MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
  MockLoadTestAgentClient,
} from "./mock-load-test-agent.js";

describe("MockLoadTestAgentClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("default model is a five minute foreground stream", async () => {
    const client = new MockLoadTestAgentClient();

    const models = await client.listModels({ cwd: "/tmp/mock-models", force: false });

    expect(models[0]).toMatchObject({
      id: MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
      isDefault: true,
      metadata: {
        durationMs: 300_000,
        intervalMs: 1000,
      },
    });
  });

  test("emits repeated markdown, reasoning, and tool calls during a foreground turn", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    const resultPromise = session.run("Exercise the app while terminals are busy.");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;
    unsubscribe();

    expect(
      events.map((event) => event.type).filter((type) => type === "turn_started"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_completed",
      provider: "mock",
    });
    expect(result).toMatchObject({
      sessionId: session.id,
      finalText: "Synthetic load test complete",
      canceled: false,
    });

    const timelineItems = events.flatMap((event): AgentTimelineItem[] =>
      event.type === "timeline" ? [event.item] : [],
    );
    expect(timelineItems.find((item) => item.type === "reasoning")).toMatchObject({
      type: "reasoning",
      text: expect.stringContaining("Thinking chunk 1"),
    });
    expect(
      timelineItems.filter(
        (item) =>
          item.type === "assistant_message" && item.text.startsWith("## Synthetic Load Cycle 1\n"),
      ),
    ).toHaveLength(1);
    expect(
      timelineItems.filter((item) => item.type === "assistant_message" && item.text.length > 0)
        .length,
    ).toBeGreaterThan(4);
    expect(
      timelineItems.filter(
        (item) =>
          item.type === "tool_call" &&
          item.name === "edit" &&
          item.status === "running" &&
          item.detail.type === "edit",
      ),
    ).toHaveLength(40);
    expect(
      timelineItems.filter(
        (item) =>
          item.type === "tool_call" &&
          item.name === "bash" &&
          item.status === "completed" &&
          item.detail.type === "shell" &&
          item.detail.output?.includes("mock load cycle"),
      ),
    ).toHaveLength(40);
  });

  test("interrupt cancels the active foreground turn and stops future chunks", async () => {
    vi.useFakeTimers();
    const client = new MockLoadTestAgentClient();
    const session = await client.createSession({
      provider: "mock",
      cwd: process.cwd(),
      model: "ten-second-stream",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.startTurn("Cancel the synthetic stream.");
    await vi.advanceTimersByTimeAsync(0);

    await session.interrupt();
    const eventCountAfterInterrupt = events.length;
    await vi.advanceTimersByTimeAsync(10_000);
    unsubscribe();

    expect(events.at(-1)).toMatchObject({
      type: "turn_canceled",
      provider: "mock",
      reason: "Interrupted",
    });
    expect(events).toHaveLength(eventCountAfterInterrupt);
  });

  test("agent manager coalesces adjacent markdown chunks from the mock provider", async () => {
    vi.useFakeTimers();
    const workdir = mkdtempSync(join(tmpdir(), "paseo-mock-load-test-"));
    try {
      const client = new MockLoadTestAgentClient();
      const manager = new AgentManager({
        clients: { mock: client },
        idFactory: () => "00000000-0000-4000-8000-000000000001",
        logger: createTestLogger(),
      });
      const agent = await manager.createAgent(
        {
          provider: "mock",
          cwd: workdir,
          model: "ten-second-stream",
        },
        "00000000-0000-4000-8000-000000000001",
      );

      const resultPromise = manager.runAgent(
        agent.id,
        "Stress the agent stream while terminal panes are active.",
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await resultPromise;

      const timeline = manager.getTimeline(agent.id);
      const loadCycleDocuments = timeline.filter(
        (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
          item.type === "assistant_message" && item.text.startsWith("## Synthetic Load Cycle "),
      );
      const editToolCalls = timeline.filter(
        (item) => item.type === "tool_call" && item.name === "edit",
      );

      expect(loadCycleDocuments).toHaveLength(40);
      expect(loadCycleDocuments[0]?.text).toContain("This paragraph is intentionally stable");
      expect(editToolCalls).toHaveLength(40);
      expect(
        editToolCalls.every((item) => item.type === "tool_call" && item.status === "completed"),
      ).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
