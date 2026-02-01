import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";
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
  let collector: MessageCollector;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    collector = createMessageCollector(ctx.client);
  });

  afterEach(async () => {
    collector.unsubscribe();
    await ctx.cleanup();
  }, 60000);

  describe("sendImages", () => {
    // Minimal 1x1 red PNG image encoded in base64
    // This is a valid PNG that can be decoded by image processing libraries
    const MINIMAL_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    test(
      "sends message with image attachment to Claude agent",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Image Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // Send message with image attachment
        await ctx.client.sendMessage(
          agent.id,
          "I'm sending you an image. Describe what information you received about the image attachment. Reply with a single short sentence.",
          {
            images: [
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/png",
              },
            ],
          }
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForFinish(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.final?.lastError).toBeUndefined();

        // Verify stream events show the agent processed the message
        const queue = collector.messages;
        const streamEvents = queue.filter(
          (m) => m.type === "agent_stream" && m.payload.agentId === agent.id
        );

        // Should have received stream events
        expect(streamEvents.length).toBeGreaterThan(0);

        // Verify turn completed successfully
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

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );

    test(
      "sends message with multiple image attachments",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Multi-Image Test Agent",
        });

        expect(agent.id).toBeTruthy();

        // Send message with two image attachments
        await ctx.client.sendMessage(
          agent.id,
          "I'm sending you two images. How many image attachments are mentioned in the context? Reply with just a number.",
          {
            images: [
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/png",
              },
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/jpeg",
              },
            ],
          }
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForFinish(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.final?.lastError).toBeUndefined();

        // Verify turn completed
        const queue = collector.messages;
        const hasTurnCompleted = queue.some(
          (m) =>
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "turn_completed"
        );
        expect(hasTurnCompleted).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );
  });


});
