import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../../test-utils/index.js";
import type { AgentSlashCommand } from "../agent-sdk-types.js";

// Fake-daemon plumbing coverage: validates manager/client command wiring without a real Claude binary.
describe("claude agent commands E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    // Add timeout to prevent hanging on Claude SDK cleanup
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([ctx?.cleanup(), timeoutPromise]);
  }, 10000);

  test("lists available slash commands for a claude agent", async () => {
    // Create a Claude agent
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd: "/tmp",
      title: "Commands Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("claude");
    expect(agent.status).toBe("idle");

    // List commands
    const result = await ctx.client.listCommands(agent.id);

    // Should have no error
    expect(result.error).toBeNull();

    // Should have commands
    expect(result.commands.length).toBeGreaterThan(0);

    // Each command should have required fields
    for (const cmd of result.commands) {
      expect(cmd.name).toBeTruthy();
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.argumentHint).toBe("string");
    }

    // Should include some well-known commands
    const commandNames = result.commands.map((c) => c.name);
    // These are skills that come from CLAUDE.md configurations
    // At minimum we should have some commands available
    expect(commandNames.length).toBeGreaterThan(0);
    expect(commandNames).toContain("rewind");
  }, 60000);

  test("returns error for non-existent agent", async () => {
    const result = await ctx.client.listCommands("non-existent-agent-id");

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Agent not found");
    expect(result.commands).toEqual([]);
  }, 30000);
});
