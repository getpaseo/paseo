import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

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
}, 60000);

describe("workspace mark unread", () => {
  test("marking a workspace unread sets attention without notifications", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Mark unread test",
    });
    expect(agent.id).toBeTruthy();
    expect(agent.requiresAttention).toBe(false);

    const workspaces = await ctx.client.fetchWorkspaces({
      subscribe: { subscriptionId: "mark-unread-e2e" },
    });
    const workspace = workspaces.entries.find((entry) => entry.workspaceDirectory === cwd);
    expect(workspace).toBeTruthy();

    messages.length = 0;

    const markedAgentIds = await ctx.client.markWorkspaceUnread(workspace!.id);

    expect(markedAgentIds).toEqual([agent.id]);

    const after = await ctx.client.fetchAgent({ agentId: agent.id });
    expect(after?.agent.requiresAttention).toBe(true);
    expect(after?.agent.attentionReason).toBe("finished");

    // Manual unread re-uses the attention state for badges and status
    // derivation, but it must not broadcast an attention notification.
    expect(messages.some((message) => message.type === "agent_attention_required")).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  }, 120000);

  test("workspace status reflects marked-unread attention", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Mark unread status test",
    });
    await ctx.client.clearAgentAttention(agent.id);

    const workspaces = await ctx.client.fetchWorkspaces({
      subscribe: { subscriptionId: "mark-unread-status-e2e" },
    });
    const workspace = workspaces.entries.find((entry) => entry.workspaceDirectory === cwd);
    expect(workspace).toBeTruthy();

    await ctx.client.markWorkspaceUnread(workspace!.id);

    const after = await ctx.client.fetchWorkspaces();
    const updated = after.entries.find((entry) => entry.id === workspace!.id);
    expect(updated?.status).toBe("attention");

    rmSync(cwd, { recursive: true, force: true });
  }, 120000);
});
