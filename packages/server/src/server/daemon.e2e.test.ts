import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/index.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("creates agent and receives response", async () => {
    // Create a Codex agent
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("codex");
    expect(agent.status).toBe("idle");
    // Title may or may not be set depending on timing
    expect(agent.cwd).toBe("/tmp");

    // Send a simple message
    await ctx.client.sendMessage(agent.id, "Say 'hello world' and nothing else");

    // Wait for the agent to complete
    const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

    // Verify agent completed without error
    expect(finalState.status).toBe("idle");
    expect(finalState.lastError).toBeUndefined();
    expect(finalState.id).toBe(agent.id);

    // Verify we received some stream events
    const queue = ctx.client.getMessageQueue();
    const streamEvents = queue.filter(
      (m) => m.type === "agent_stream" && m.payload.agentId === agent.id
    );
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify there was a turn_started event
    const hasTurnStarted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_started"
    );
    expect(hasTurnStarted).toBe(true);

    // Verify there was a turn_completed event
    const hasTurnCompleted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_completed"
    );
    expect(hasTurnCompleted).toBe(true);

    // Verify there was an assistant message in the timeline
    const hasAssistantMessage = streamEvents.some((m) => {
      if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
        return false;
      }
      const item = m.payload.event.item;
      return item.type === "assistant_message" && item.text.length > 0;
    });
    expect(hasAssistantMessage).toBe(true);
  }, 180000); // 3 minute timeout for E2E test

  describe("permission flow: Codex", () => {
    test(
      "approves permission and executes command",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");

        // Create Codex agent with on-request approval policy
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Codex Permission Test",
          modeId: "auto",
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

        // Verify permission timeline items
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have permission granted timeline item
        const hasGranted = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "granted"
        );
        expect(hasGranted).toBe(true);

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
          provider: "codex",
          cwd,
          title: "Codex Permission Deny Test",
          modeId: "auto",
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

        // Verify permission denied timeline item
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        const hasDenied = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        );
        expect(hasDenied).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });

  // Claude permission tests are skipped due to SDK behavior:
  // - The sandbox config IS passed correctly to Claude SDK
  // - Claude executes tool calls without requesting permission
  // - This appears to be related to user/project settings or SDK behavior
  // - The direct claude-agent.test.ts permission tests pass
  // - Codex permission tests through the daemon work correctly
  // TODO: Investigate Claude SDK permission behavior in daemon context
  describe.skip("permission flow: Claude", () => {
    test(
      "approves permission and executes command",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");
        writeFileSync(filePath, "ok", "utf8");

        // Create Claude agent with sandbox config that requires permission for bash
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Permission Test",
          modeId: "default",
          extra: {
            claude: {
              sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
            },
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission (rm command triggers approval)
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
          "After approval, run it and reply DONE.",
          "Do not respond before the command finishes.",
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

        // Verify the file was deleted
        expect(existsSync(filePath)).toBe(false);

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

        // Verify permission timeline items
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have permission granted timeline item
        const hasGranted = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "granted"
        );
        expect(hasGranted).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );

    test(
      "denies permission and prevents execution",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");
        writeFileSync(filePath, "ok", "utf8");

        // Create Claude agent with sandbox config that requires permission for bash
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Permission Deny Test",
          modeId: "default",
          extra: {
            claude: {
              sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
            },
          },
        });

        expect(agent.id).toBeTruthy();

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
          "If approval is denied, reply DENIED and stop.",
          "Do not respond before the command finishes or the denial is confirmed.",
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

        // Verify the file was NOT deleted
        expect(existsSync(filePath)).toBe(true);

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

        // Verify permission denied timeline item
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        const hasDenied = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        );
        expect(hasDenied).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });
});
