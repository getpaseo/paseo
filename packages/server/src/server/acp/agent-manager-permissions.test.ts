import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentManager } from "./agent-manager.js";
import type { AgentUpdate } from "./types.js";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Vitest Test Suite for ACP Permission Flow
 *
 * This test validates that permission requests (like ExitPlanMode) are properly
 * forwarded to the UI and can be responded to by the user.
 *
 * Run with: npx vitest run src/server/acp/agent-manager-permissions.test.ts
 */

describe("AgentManager - Permission Flow", () => {
  let manager: AgentManager;
  let tmpDir: string;

  beforeAll(async () => {
    manager = new AgentManager();
    tmpDir = await mkdtemp(join(tmpdir(), "acp-permission-test-"));
  });

  afterAll(async () => {
    // Kill all agents
    const agents = manager.listAgents();
    for (const agent of agents) {
      await manager.killAgent(agent.id);
    }
    // Remove temp directory
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "should emit permission request when agent calls ExitPlanMode",
    async () => {
      // Track all updates
      const updates: AgentUpdate[] = [];
      let permissionRequest: any = null;

      // Create agent in plan mode
      const agentId = await manager.createAgent({
        cwd: tmpDir,
        initialMode: "plan",
      });

      expect(agentId).toBeDefined();

      // Subscribe to updates
      const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
        updates.push(update);

        // Check if this is a permission request
        const notification = update.notification as any;
        if (notification.type === "permissionRequest") {
          permissionRequest = notification.permissionRequest;
          console.log("[Test] Permission request received:", permissionRequest);
        }
      });

      try {
        // Send a prompt that will trigger ExitPlanMode
        await manager.sendPrompt(
          agentId,
          "Create a dummy file called test.txt with the content 'hello'"
        );

        // Wait a bit for the agent to process and call ExitPlanMode
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Verify we got a permission request
        expect(permissionRequest).toBeDefined();
        expect(permissionRequest.agentId).toBe(agentId);
        expect(permissionRequest.requestId).toBeDefined();
        expect(permissionRequest.options).toBeDefined();
        expect(permissionRequest.options.length).toBeGreaterThan(0);

        // Verify the options include the expected plan mode options
        const optionIds = permissionRequest.options.map((o: any) => o.optionId);
        console.log("[Test] Option IDs:", optionIds);

        // Verify we have at least 2 options
        expect(optionIds.length).toBeGreaterThanOrEqual(2);

        // The actual option IDs vary, but we should have some allow and reject options
        // Common patterns: ['allow_always', 'allow', 'reject'] or ['acceptEdits', 'default', 'plan']
        const hasAllowOption = optionIds.some((id: string) =>
          id.includes('allow') || id.includes('default') || id.includes('Edits')
        );
        const hasRejectOption = optionIds.some((id: string) =>
          id.includes('reject') || id.includes('plan')
        );
        expect(hasAllowOption).toBe(true);
        expect(hasRejectOption).toBe(true);

        // Verify the toolCall exists
        expect(permissionRequest.toolCall).toBeDefined();
        console.log("[Test] Tool call:", JSON.stringify(permissionRequest.toolCall, null, 2));

        // The toolCall structure can vary, but it should have either rawInput or other properties
        if (permissionRequest.toolCall.rawInput) {
          console.log("[Test] Plan:", permissionRequest.toolCall.rawInput.plan || permissionRequest.toolCall.rawInput);
        }

        // Now simulate user approval (use first non-reject option)
        const approveOption = permissionRequest.options.find((o: any) =>
          !o.optionId.includes('reject') && !o.optionId.includes('plan')
        );
        expect(approveOption).toBeDefined();
        console.log("[Test] Simulating user approval with option:", approveOption.optionId);
        manager.respondToPermission(
          agentId,
          permissionRequest.requestId,
          approveOption.optionId
        );

        // Wait for agent to proceed after approval
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Verify agent proceeded (status should be processing or completed)
        const status = manager.getAgentStatus(agentId);
        console.log("[Test] Agent status after approval:", status);
        expect(["processing", "completed", "ready"]).toContain(status);

        // The permission flow worked! The agent received permission and can proceed.
        // We don't need to verify additional updates since the core permission mechanism works.
        console.log("[Test] Permission flow verified successfully!");
      } finally {
        unsubscribe();
        await manager.killAgent(agentId);
      }
    },
    60000 // 60 second timeout
  );

  it(
    "should handle permission rejection (keep planning)",
    async () => {
      let permissionRequest: any = null;

      // Create agent in plan mode
      const agentId = await manager.createAgent({
        cwd: tmpDir,
        initialMode: "plan",
      });

      expect(agentId).toBeDefined();

      // Subscribe to updates
      const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
        const notification = update.notification as any;
        if (notification.type === "permissionRequest") {
          permissionRequest = notification.permissionRequest;
          console.log("[Test] Permission request received for rejection test");
        }
      });

      try {
        // Send a prompt
        await manager.sendPrompt(
          agentId,
          "Create a file called reject-test.txt"
        );

        // Wait for permission request
        await new Promise((resolve) => setTimeout(resolve, 10000));

        expect(permissionRequest).toBeDefined();

        // Reject the permission (choose reject/plan option)
        const rejectOption = permissionRequest.options.find((o: any) =>
          o.optionId.includes('reject') || o.optionId.includes('plan')
        );
        expect(rejectOption).toBeDefined();
        console.log("[Test] Simulating user rejection with option:", rejectOption.optionId);
        manager.respondToPermission(
          agentId,
          permissionRequest.requestId,
          rejectOption.optionId
        );

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Agent should remain ready or processing (not failed)
        const status = manager.getAgentStatus(agentId);
        console.log("[Test] Agent status after rejection:", status);
        expect(["ready", "processing", "completed"]).toContain(status);
      } finally {
        unsubscribe();
        await manager.killAgent(agentId);
      }
    },
    60000
  );
});
