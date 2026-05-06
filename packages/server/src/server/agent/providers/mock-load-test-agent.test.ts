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

  test("default model is a five minute foreground stream with token-rate intervals", async () => {
    const client = new MockLoadTestAgentClient();

    const models = await client.listModels({ cwd: "/tmp/mock-models", force: false });

    expect(models[0]).toMatchObject({
      id: MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
      isDefault: true,
      metadata: {
        durationMs: 300_000,
        intervalMs: 40,
      },
    });
  });

  test("emits sub-word tokens, reasoning, and sequential tool calls during a foreground turn", async () => {
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

    const assistantTokens = timelineItems.filter((item) => item.type === "assistant_message");
    const reasoningTokens = timelineItems.filter((item) => item.type === "reasoning");
    const toolCalls = timelineItems.filter((item) => item.type === "tool_call");

    // Many small token deltas, not a few big chunks.
    expect(assistantTokens.length).toBeGreaterThan(200);
    expect(reasoningTokens.length).toBeGreaterThan(20);

    // Average token length should be sub-word (a few characters).
    const avgTokenLength =
      assistantTokens.reduce(
        (sum, item) => sum + (item.type === "assistant_message" ? item.text.length : 0),
        0,
      ) / assistantTokens.length;
    expect(avgTokenLength).toBeLessThan(10);

    // First assistant token starts the cycle header.
    expect(assistantTokens[0]).toMatchObject({
      type: "assistant_message",
      text: expect.stringContaining("##"),
    });

    // Sequential tool calls fire: read, grep, edit, bash.
    const toolNames = toolCalls
      .filter((item) => item.type === "tool_call" && item.status === "running")
      .map((item) => (item.type === "tool_call" ? item.name : ""));
    expect(toolNames.slice(0, 4)).toEqual(["read", "grep", "edit", "bash"]);

    // Each tool transitions running → completed.
    const completedNames = toolCalls
      .filter((item) => item.type === "tool_call" && item.status === "completed")
      .map((item) => (item.type === "tool_call" ? item.name : ""));
    expect(completedNames).toContain("read");
    expect(completedNames).toContain("grep");
    expect(completedNames).toContain("edit");
    expect(completedNames).toContain("bash");
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

  test("agent manager coalesces adjacent assistant tokens into fewer messages", async () => {
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
      const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
      const toolCalls = timeline.filter((item) => item.type === "tool_call");

      // The provider streams sub-word tokens; the coalescer batches them within
      // its flush window, so the timeline must contain materially fewer messages
      // than the underlying token deltas would suggest, and each message must
      // hold multiple tokens worth of text.
      expect(assistantMessages.length).toBeGreaterThan(0);
      const totalAssistantChars = assistantMessages.reduce(
        (sum, item) => sum + (item.type === "assistant_message" ? item.text.length : 0),
        0,
      );
      const avgMessageLength = totalAssistantChars / assistantMessages.length;
      expect(avgMessageLength).toBeGreaterThan(8);
      const longestMessage = assistantMessages
        .map((item) => (item.type === "assistant_message" ? item.text.length : 0))
        .reduce((max, length) => Math.max(max, length), 0);
      expect(longestMessage).toBeGreaterThan(20);

      // First message includes the cycle header.
      expect(assistantMessages[0]).toMatchObject({
        type: "assistant_message",
        text: expect.stringContaining("## Cycle 1"),
      });

      // Tool calls land in expected order at least once.
      const runningTools = toolCalls
        .filter((item) => item.type === "tool_call" && item.status === "completed")
        .map((item) => (item.type === "tool_call" ? item.name : ""));
      expect(runningTools).toEqual(expect.arrayContaining(["read", "grep", "edit", "bash"]));
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
