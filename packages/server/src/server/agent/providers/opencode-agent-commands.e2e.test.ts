import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../../test-utils/index.js";
import { getFullAccessConfig } from "../../daemon-e2e/agent-configs.js";

describe("opencode agent commands E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("lists available slash commands for an opencode agent", async () => {
    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("opencode"),
      cwd: "/tmp",
      title: "OpenCode Commands Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("opencode");
    expect(agent.status).toBe("idle");

    const result = await ctx.client.listCommands(agent.id);

    expect(result.error).toBeNull();
    expect(result.commands.length).toBeGreaterThan(0);

    for (const cmd of result.commands) {
      expect(cmd.name).toBeTruthy();
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.argumentHint).toBe("string");
      expect(cmd.name.startsWith("/")).toBe(false);
    }
  }, 60_000);

  test("sendMessage executes a slash command without arguments", async () => {
    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("opencode"),
      cwd: "/tmp",
      title: "OpenCode Slash Command No Args",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("opencode");

    await ctx.client.sendMessage(agent.id, "/help");
    const state = await ctx.client.waitForFinish(agent.id, 30_000);

    expect(state.status).toBe("idle");
    expect(state.lastMessage).toContain("PASEO_SKILL_OK");
  }, 30_000);

  test("sendMessage executes a slash command with arguments", async () => {
    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("opencode"),
      cwd: "/tmp",
      title: "OpenCode Slash Command With Args",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("opencode");

    await ctx.client.sendMessage(agent.id, "/help some-topic");
    const state = await ctx.client.waitForFinish(agent.id, 30_000);

    expect(state.status).toBe("idle");
    expect(state.lastMessage).toContain("PASEO_SKILL_OK");
  }, 30_000);

  test("sendMessage keeps unknown slash input as plain prompt text", async () => {
    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("opencode"),
      cwd: "/tmp",
      title: "OpenCode Slash Fallback",
    });

    const token = `RAW_PROMPT_TOKEN_${Date.now()}`;
    await ctx.client.sendMessage(agent.id, `/not-a-real-command respond with exactly: ${token}`);
    const state = await ctx.client.waitForFinish(agent.id, 30_000);

    expect(state.status).toBe("idle");
    expect(state.lastMessage).toContain(token);
  }, 30_000);

  test("returns error for non-existent agent", async () => {
    const result = await ctx.client.listCommands("non-existent-agent-id");

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Agent not found");
    expect(result.commands).toEqual([]);
  }, 60_000);
});
