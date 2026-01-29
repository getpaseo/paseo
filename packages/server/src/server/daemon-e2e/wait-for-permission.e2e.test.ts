import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "wait-perm-e2e-"));
}

/**
 * Tests for wait returning on permission request.
 *
 * The `paseo wait` command should return when:
 * 1. Agent completes (goes idle)
 * 2. Agent requests permission
 *
 * This test verifies that waitForAgentIdle correctly returns when
 * an agent requests permission, not just when it goes idle.
 */
describe("wait returns on permission request", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("Claude provider", () => {
    test(
      "waitForAgentIdle returns when permission is requested (not just when idle)",
      async () => {
        const cwd = tmpCwd();
        const testFilePath = path.join(cwd, "test-wait-perm.txt");

        // Create Claude agent with default mode (always ask for permissions)
        const agent = await ctx.client.createAgent({
          provider: "claude",
          model: "haiku",
          cwd,
          title: "Wait Permission Test",
          modeId: "default",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires file write permission
        const prompt = [
          `You must use the Write tool to create a file at "${testFilePath}" with content "hello".`,
          "Do not respond before attempting to write the file.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // CRITICAL: This is the behavior we're testing
        // waitForAgentIdle should return when permission is requested,
        // NOT wait until the agent is fully idle (which would timeout or
        // require us to approve the permission first)
        const startTime = Date.now();
        const state = await ctx.client.waitForAgentIdle(agent.id, 60000);
        const waitDuration = Date.now() - startTime;

        // If wait returns because of permission request, we should have:
        // 1. Agent status still "running" (not idle yet - waiting for permission)
        // 2. Pending permissions in the state
        // 3. Wait should return quickly (under 30 seconds, not timeout)

        // Check that we have a pending permission
        const hasPendingPermission =
          (state.pendingPermissions && state.pendingPermissions.length > 0);

        // Log for debugging
        console.log("Wait returned after", waitDuration, "ms");
        console.log("Agent status:", state.status);
        console.log("Pending permissions:", state.pendingPermissions?.length ?? 0);

        // THE ASSERTION:
        // If waitForAgentIdle correctly yields on permission request,
        // we should either:
        // - Get a state with pending permissions (status might be "running")
        // - Or the state should be from right when permission was requested
        //
        // If waitForAgentIdle does NOT yield on permission request,
        // this test will either:
        // - Timeout (60s)
        // - Return only after we never approve permission and agent errors/gives up

        // This test will FAIL if waitForAgentIdle waits for full idle
        // instead of returning on permission request
        expect(hasPendingPermission).toBe(true);

        // Also verify we can get the permission via waitForPermission
        // (This should return immediately since permission is already pending)
        const permission = await ctx.client.waitForPermission(agent.id, 5000);
        expect(permission).toBeTruthy();
        expect(permission.kind).toBe("tool");

        // Clean up: deny the permission so agent can finish
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "deny",
          message: "Test complete",
        });

        // Wait for agent to finish processing the denial
        await ctx.client.waitForAgentIdle(agent.id, 30000);

        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      120000
    );
  });
});
