import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

function extractAssistantText(queue: SessionOutboundMessage[], agentId: string): string {
  const parts: string[] = [];
  for (const m of queue) {
    if (m.type !== "agent_stream") continue;
    if (m.payload.agentId !== agentId) continue;
    if (m.payload.event.type !== "timeline") continue;
    const item = m.payload.event.item;
    if (item.type === "assistant_message") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

describe("daemon E2E - streaming", () => {
  let ctx: DaemonTestContext;
  let messages: SessionOutboundMessage[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    messages = [];
    unsubscribe = ctx.client.subscribeRawMessages((message) => {
      messages.push(message);
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    await ctx.cleanup();
  }, 30_000);

  test(
    "streams assistant_message chunks that concatenate correctly",
    async () => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Streaming concat test",
          modeId: "bypassPermissions",
        });

        messages.length = 0;
        await ctx.client.sendMessage(
          agent.id,
          "Please complete this sentence with exactly one more sentence: 'The quick brown fox jumps over the lazy dog.'"
        );
        const finalState = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(finalState.status).toBe("idle");

        const assistantText = extractAssistantText(messages, agent.id);
        expect(assistantText).toBe(
          "The quick brown fox jumps over the lazy dog. Then the fox ran away."
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );

  test(
    "sending a new message while a run is active does not mix streams",
    async () => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Overlap stream test",
          modeId: "full-access",
        });

        messages.length = 0;
        await ctx.client.sendMessage(agent.id, "Run: sleep 30");

        await ctx.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          5_000
        );

        await ctx.client.sendMessage(agent.id, "Say 'state saved' and nothing else");
        const finalState = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(finalState.status).toBe("idle");

        const assistantText = extractAssistantText(messages, agent.id).toLowerCase();
        expect(assistantText).toContain("state saved");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );
});

