import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { AgentManager } from "./agent-manager.js";
import type { AgentUpdate, AgentNotification } from "./types.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("AgentManager", () => {
  let tmpDir: string;
  const createdAgents: Array<{ manager: AgentManager; agentId: string }> = [];

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "acp-test-"));
  });

  afterEach(async () => {
    // Clean up all agents created during tests
    for (const { manager, agentId } of createdAgents) {
      try {
        await manager.deleteAgent(agentId);
      } catch (error) {
        console.error(`Failed to delete agent ${agentId}:`, error);
      }
    }
    createdAgents.length = 0;
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should create file after accepting plan", async () => {
    const manager = new AgentManager();
    let permissionRequest: RequestPermissionRequest | null = null;
    let requestId: string | null = null;
    const testFile = join(tmpDir, "test.txt");

    const agentId = await manager.createAgent({
      cwd: tmpDir,
      type: "claude",
      initialMode: "plan",
    });
    createdAgents.push({ manager, agentId });

    const unsubscribe = manager.subscribeToUpdates(
      agentId,
      (update: AgentUpdate) => {
        const notification: AgentNotification = update.notification;
        if (notification.type === "permission") {
          permissionRequest = notification.request;
          requestId = notification.requestId;
        }
      }
    );

    try {
      await manager.sendPrompt(
        agentId,
        "Create a file called test.txt with the content 'hello world'"
      );

      let attempts = 0;
      while (!permissionRequest && attempts < 40) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        attempts++;
      }

      expect(permissionRequest).toBeDefined();
      expect(requestId).toBeDefined();

      const acceptOption = permissionRequest!.options.find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always"
      );
      expect(acceptOption).toBeDefined();

      manager.respondToPermission(agentId, requestId!, acceptOption!.optionId);

      let status = manager.getAgentStatus(agentId);
      attempts = 0;
      while (status !== "completed" && status !== "failed" && attempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = manager.getAgentStatus(agentId);
        attempts++;
      }

      expect(status).toBe("completed");

      const content = await readFile(testFile, "utf-8");
      expect(content).toContain("hello world");

      const agentInfo = manager.listAgents().find((a) => a.id === agentId);
      expect(agentInfo?.currentModeId).toBe("acceptEdits");
    } finally {
      unsubscribe();
    }
  }, 120000);

  it("should not fail when sending '.' after plan permission request", async () => {
    const manager = new AgentManager();
    let permissionRequest: RequestPermissionRequest | null = null;
    let requestId: string | null = null;

    const agentId = await manager.createAgent({
      cwd: tmpDir,
      type: "claude",
      initialMode: "plan",
    });
    createdAgents.push({ manager, agentId });

    const unsubscribe = manager.subscribeToUpdates(
      agentId,
      (update: AgentUpdate) => {
        const notification: AgentNotification = update.notification;
        if (notification.type === "permission") {
          permissionRequest = notification.request;
          requestId = notification.requestId;
        }
      }
    );

    try {
      await manager.sendPrompt(
        agentId,
        "Create a file called test.txt with the content 'hello world'"
      );

      let attempts = 0;
      while (!permissionRequest && attempts < 40) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        attempts++;
      }

      expect(permissionRequest).toBeDefined();
      expect(requestId).toBeDefined();

      console.log("Permission request received, now sending '.' message instead of responding");

      // Instead of responding to permission, send a "." message
      await manager.sendPrompt(agentId, ".");

      // Wait for agent to finish processing
      let status = manager.getAgentStatus(agentId);
      let waitAttempts = 0;
      while (status === "processing" && waitAttempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = manager.getAgentStatus(agentId);
        waitAttempts++;
      }

      const agentInfo = manager.listAgents().find((a) => a.id === agentId);
      const updates = manager.getAgentUpdates(agentId);
      const sessionUpdates = updates.filter(u => u.notification.type === "session");

      console.log("Agent status after '.' message:", status);
      console.log("Agent error:", agentInfo?.error);
      console.log("Session updates count:", sessionUpdates.length);
      console.log("Last few updates:", updates.slice(-5).map(u => ({
        type: u.notification.type,
        timestamp: u.timestamp,
      })));

      // The agent should NOT be in failed state
      expect(status).not.toBe("failed");
      
      // The agent should be in a usable state (ready, completed, or processing)
      expect(["ready", "completed", "processing"]).toContain(status);
      
      // There should be no error
      expect(agentInfo?.error).toBeNull();
    } finally {
      unsubscribe();
    }
  }, 120000);

  describe("persistence", () => {
    it("should load persisted agent and send new prompt", async () => {
      const manager = new AgentManager();
      const agentId = await manager.createAgent({
        cwd: tmpDir,
        type: "claude",
      });
      createdAgents.push({ manager, agentId });

      await manager.sendPrompt(agentId, "echo 'first message'");

      let status = manager.getAgentStatus(agentId);
      let attempts = 0;
      while (status !== "completed" && status !== "failed" && attempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = manager.getAgentStatus(agentId);
        attempts++;
      }

      expect(status).toBe("completed");

      const agentBeforeKill = manager
        .listAgents()
        .find((a) => a.id === agentId);
      const claudeSessionId = manager.getClaudeSessionId(agentId);
      console.log("Before kill - ACP Session ID:", agentBeforeKill?.sessionId);
      console.log("Before kill - Claude Session ID:", claudeSessionId);
      console.log("Working directory:", tmpDir);

      await manager.killAgent(agentId);

      const newManager = new AgentManager();
      await newManager.initialize();

      // Update the tracking to use the new manager instance
      const trackingIndex = createdAgents.findIndex(
        (a) => a.agentId === agentId
      );
      if (trackingIndex >= 0) {
        createdAgents[trackingIndex] = { manager: newManager, agentId };
      }

      const agents = newManager.listAgents();
      const loadedAgent = agents.find((a) => a.id === agentId);
      const loadedClaudeSessionId = newManager.getClaudeSessionId(agentId);

      console.log("After reload - ACP Session ID:", loadedAgent?.sessionId);
      console.log("After reload - Claude Session ID:", loadedClaudeSessionId);

      expect(loadedAgent).toBeDefined();
      expect(loadedAgent?.id).toBe(agentId);
      expect(loadedAgent?.cwd).toBe(tmpDir);

      await newManager.initializeAgentAndGetHistory(agentId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const persistedUpdates = newManager.getAgentUpdates(agentId);

      console.log(
        "Persisted updates:",
        JSON.stringify(persistedUpdates, null, 2)
      );

      await newManager.sendPrompt(agentId, "echo 'second message'");

      status = newManager.getAgentStatus(agentId);
      attempts = 0;
      while (status !== "completed" && status !== "failed" && attempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = newManager.getAgentStatus(agentId);
        attempts++;
      }

      expect(status).toBe("completed");

      const finalUpdates = newManager.getAgentUpdates(agentId);
      expect(finalUpdates.length).toBeGreaterThan(0);

      console.log("Final updates:", finalUpdates);
    }, 120000);
  });
});
