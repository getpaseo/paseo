import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.1-codex-mini with low reasoning effort for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("creates agent and receives response", async () => {
    // Create a Codex agent
    const agent = await ctx.client.createAgent({
      provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      cwd: "/tmp",
      title: "Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("codex");
    expect(agent.status).toBe("idle");
    // Title may or may not be set depending on timing
    expect(agent.cwd).toBe("/tmp");

    // Send a simple message
    await ctx.client.sendMessage(agent.id, "Say 'hello world' and nothing else");

    // Wait for the agent to complete
    const finalState = await ctx.client.waitForFinish(agent.id, 120000);

    // Verify agent completed without error
    expect(finalState.status).toBe("idle");
    expect(finalState.lastError).toBeUndefined();
    expect(finalState.id).toBe(agent.id);

    // Verify we received some stream events
    const queue = ctx.client.getMessageQueue();
    const streamEvents = queue.filter(
      (m) => m.type === "agent_stream" && m.payload.agentId === agent.id
    );
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify there was a turn_started event
    const hasTurnStarted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_started"
    );
    expect(hasTurnStarted).toBe(true);

    // Verify there was a turn_completed event
    const hasTurnCompleted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_completed"
    );
    expect(hasTurnCompleted).toBe(true);

    // Verify there was an assistant message in the timeline
    const hasAssistantMessage = streamEvents.some((m) => {
      if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
        return false;
      }
      const item = m.payload.event.item;
      return item.type === "assistant_message" && item.text.length > 0;
    });
    expect(hasAssistantMessage).toBe(true);
  }, 180000); // 3 minute timeout for E2E test


  test("fails to create agent with non-existent cwd", async () => {
    const nonExistentCwd = "/this/path/does/not/exist/12345";

    const result = await ctx.client.createAgentExpectFail({
      provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
      cwd: nonExistentCwd,
      title: "Should Fail Agent",
    });

    expect(result.error).toContain("Working directory does not exist");
    expect(result.error).toContain(nonExistentCwd);
  });


});
