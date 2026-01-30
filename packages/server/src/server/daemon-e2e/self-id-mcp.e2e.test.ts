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

    // Wait for agent to complete (MCP tools may auto-approve without permission)
    // If a permission is requested, approve it
    let finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

    // Check if we got blocked on permission
    if (finalState.status === "running" && finalState.pendingPermissions?.length) {
      const permission = finalState.pendingPermissions[0];
      await ctx.client.respondToPermission(agent.id, permission.id, {
        behavior: "allow",
      });
      finalState = await ctx.client.waitForAgentIdle(agent.id, 60000);
    }

    // Log final state for debugging if not idle
    if (finalState.status !== "idle") {
      console.error(
        "Agent did not reach idle state:",
        JSON.stringify(finalState, null, 2)
      );
    }

    expect(finalState.status).toBe("idle");
    expect(finalState.lastError).toBeUndefined();

    // Verify the title was changed via set_title
    expect(finalState.title).toBe("Updated via MCP");
  }, 180000);
});
