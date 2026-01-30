import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
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

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("permission flow: Codex", () => {
    test(
      "approves permission and executes command",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");

        // Create Codex agent with on-request approval policy
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Codex Permission Test",
          modeId: "read-only",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt`.",
          "After approval, run it and reply DONE.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();
        expect(permission.kind).toBe("tool");

        // Approve the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was created
        expect(existsSync(filePath)).toBe(true);

        // Verify permission_resolved event was received
        const queue = ctx.client.getMessageQueue();
        const hasPermissionResolved = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "allow"
            );
          }
          return false;
        });
        expect(hasPermissionResolved).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );

    test(
      "denies permission and prevents execution",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");

        // Create Codex agent with on-request approval policy
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Codex Permission Deny Test",
          modeId: "read-only",
        });

        expect(agent.id).toBeTruthy();

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt`.",
          "If approval is denied, acknowledge and stop.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();

        // Deny the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "deny",
          message: "Not allowed.",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was NOT created
        expect(existsSync(filePath)).toBe(false);

        // Verify permission_resolved event was received with deny
        const queue = ctx.client.getMessageQueue();
        const hasPermissionDenied = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "deny"
            );
          }
          return false;
        });
        expect(hasPermissionDenied).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );

    // TODO: Fix this test - there's a race condition causing agent not found errors
    test.skip(
      "Codex agent can complete a new turn after interrupt",
      async () => {
        const cwd = tmpCwd();

        // Create Codex agent with full-access (no permissions needed)
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Codex Interrupt Test",
          modeId: "full-access",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.currentModeId).toBe("full-access");

        // Send first message to start the agent
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(agent.id, "List the files in the current directory.");

        // Wait for agent to start running
        await ctx.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          10000
        );

        // Cancel while running
        await ctx.client.cancelAgent(agent.id);

        // Wait for agent to become idle after cancellation
        // Don't use waitForAgentIdle because it requires seeing "running" first,
        // but we already saw it above. Just wait for "idle" or "error".
        await ctx.client.waitForAgentUpsert(
          agent.id,
          (snapshot) =>
            snapshot.status === "idle" || snapshot.status === "error",
          30000
        );

        // Now send another message - this should work
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(
          agent.id,
          "Say 'hello from interrupt test' and nothing else."
        );

        // Wait for this to complete
        await ctx.client.waitForAgentIdle(agent.id, 60000);

        // Verify we got an assistant message in the queue
        const queue = ctx.client.getMessageQueue();
        const hasAssistantMessage = queue.some(
          (m) =>
            m.type === "agent_stream" &&
            m.agentId === agent.id &&
            m.event?.type === "timeline" &&
            m.event?.item?.type === "assistant_message"
        );
        expect(hasAssistantMessage).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      120000
    );

    test(
      "aborting Codex actually stops execution (sleep + write test)",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "abort-test-file.txt");

        // Create Codex agent with full-access (no permissions needed)
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Codex Abort Stop Test",
          modeId: "full-access",
        });

        expect(agent.id).toBeTruthy();

        // Ask Codex to sleep 15 seconds then write a file
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(
          agent.id,
          "Run this bash command: sleep 15 && echo 'abort-test-completed' > abort-test-file.txt"
        );

        // Wait 3 seconds for the command to start
        await new Promise((r) => setTimeout(r, 3000));

        // Cancel/interrupt the agent
        await ctx.client.cancelAgent(agent.id);

        // Wait 10 seconds - if abort works, file should NOT be written
        // (sleep would have completed at 15s if not interrupted)
        await new Promise((r) => setTimeout(r, 10000));

        // Assert the file was NOT created (proving Codex actually stopped)
        const fileExists = existsSync(filePath);
        expect(fileExists).toBe(false);

        rmSync(cwd, { recursive: true, force: true });
      },
      30000 // 30 second timeout
    );

    // TODO: Fix this test - there's a race condition causing timeout errors
    test.skip(
      "switching from auto to full-access mode allows writes without permission",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "mode-switch-test.txt");

        // Step 1: Create Codex agent with "auto" mode (requires permission for writes)
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Codex Mode Switch Permission Test",
          modeId: "auto",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.currentModeId).toBe("auto");

        // Step 2: Ask agent to write a file - this should trigger permission request
        // Note: We DON'T tell the agent to "stop" if denied - this keeps the conversation
        // alive and tests the real scenario where mode switch must work mid-conversation.
        ctx.client.clearMessageQueue();
        const writePrompt =
          "Write a file called mode-switch-test.txt with the content 'first'";

        await ctx.client.sendMessage(agent.id, writePrompt);

        // Step 3: Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();

        // Step 4: Deny the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "deny",
          message: "Permission denied for test.",
        });

        // Wait for agent to complete after denial
        await ctx.client.waitForAgentIdle(agent.id, 120000);

        // Verify file was NOT created after denial
        expect(existsSync(filePath)).toBe(false);

        // Step 5: Switch to "full-access" mode
        ctx.client.clearMessageQueue();
        const modeStartPosition = ctx.client.getMessageQueue().length;

        await ctx.client.setAgentMode(agent.id, "full-access");

        // Wait for mode change to be reflected in agent_update
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout waiting for full-access mode change"));
          }, 15000);

          const checkForModeChange = (): void => {
            const queue = ctx.client.getMessageQueue();
            for (let i = modeStartPosition; i < queue.length; i++) {
              const msg = queue[i];
              if (
                msg.type === "agent_update" &&
                msg.payload.kind === "upsert" &&
                msg.payload.agent.id === agent.id &&
                msg.payload.agent.currentModeId === "full-access"
              ) {
                clearTimeout(timeout);
                clearInterval(interval);
                resolve();
                return;
              }
            }
          };

          const interval = setInterval(checkForModeChange, 50);
        });

        // Step 6: Ask agent to write file again - should succeed WITHOUT permission request
        // In full-access mode, the agent should just execute without asking.
        ctx.client.clearMessageQueue();
        const writePrompt2 =
          "Write a file called mode-switch-test.txt with the content 'success'";

        await ctx.client.sendMessage(agent.id, writePrompt2);

        // Wait for agent to complete
        await ctx.client.waitForAgentIdle(agent.id, 120000);

        // Step 7: Verify file was created (mode switch worked)
        expect(existsSync(filePath)).toBe(true);
        const content = readFileSync(filePath, "utf-8");
        expect(content).toBe("success");

        // Verify no permission was requested in this second attempt
        const queue = ctx.client.getMessageQueue();
        const hasPermissionRequest = queue.some(
          (m) =>
            m.type === "agent_permission_request" &&
            m.agentId === agent.id
        );
        expect(hasPermissionRequest).toBe(false);

        rmSync(cwd, { recursive: true, force: true });
      },
      240000
    );
  });


});
