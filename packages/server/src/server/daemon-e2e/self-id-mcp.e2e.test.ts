import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";

describe("self-id MCP e2e", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("UI agent can call set_title to change its title", async () => {
    // Create a Claude agent with ui=true label (triggers MCP injection)
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd: "/tmp",
      title: "Initial Title",
      labels: { ui: "true" },
    });

    expect(agent.id).toBeTruthy();
    expect(agent.title).toBe("Initial Title");

    // Send a message asking the agent to call set_title
    await ctx.client.sendMessage(
      agent.id,
      "Use the set_title MCP tool to change your title to 'Updated via MCP'. Only call set_title, nothing else."
    );

    // Wait for permission request (default mode requires permission for MCP tools)
    const state = await ctx.client.waitForFinish(agent.id, 60000);
    expect(state.pendingPermissions?.length).toBeGreaterThan(0);
    expect(state.pendingPermissions![0].name).toBe("mcp__paseo-self-id__set_title");

    // Approve the permission
    await ctx.client.respondToPermission(agent.id, state.pendingPermissions![0].id, {
      behavior: "allow",
    });

    // Wait for agent to complete
    const finalState = await ctx.client.waitForFinish(agent.id, 60000);
    expect(finalState.status).toBe("idle");
    expect(finalState.title).toBe("Updated via MCP");
  }, 180000);
});
