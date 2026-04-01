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

  test("returns error for non-existent agent", async () => {
    const result = await ctx.client.listCommands("non-existent-agent-id");

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Agent not found");
    expect(result.commands).toEqual([]);
  }, 60_000);
});
