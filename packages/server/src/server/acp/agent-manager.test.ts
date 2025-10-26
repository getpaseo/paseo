import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentManager } from "./agent-manager.js";
import type { AgentUpdate, AgentNotification } from "./types.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("AgentManager", () => {
  let manager: AgentManager;
  let tmpDir: string;

  beforeAll(async () => {
    manager = new AgentManager();
    tmpDir = await mkdtemp(join(tmpdir(), "acp-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "should create file after accepting plan",
    async () => {
      let permissionRequest: RequestPermissionRequest | null = null;
      let requestId: string | null = null;
      const testFile = join(tmpDir, "test.txt");

      const agentId = await manager.createAgent({
        cwd: tmpDir,
        initialMode: "plan",
      });

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
        await manager.killAgent(agentId);
      }
    },
    120000
  );

  it(
    "should load persisted agent and send new prompt",
    async () => {
      const agentId = await manager.createAgent({
        cwd: tmpDir,
      });

      await manager.sendPrompt(agentId, "echo 'first message'");

      let status = manager.getAgentStatus(agentId);
      let attempts = 0;
      while (status !== "completed" && status !== "failed" && attempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = manager.getAgentStatus(agentId);
        attempts++;
      }

      expect(status).toBe("completed");

      await manager.killAgent(agentId);

      const newManager = new AgentManager();
      await newManager.initialize();

      const agents = newManager.listAgents();
      const loadedAgent = agents.find((a) => a.id === agentId);

      expect(loadedAgent).toBeDefined();
      expect(loadedAgent?.id).toBe(agentId);
      expect(loadedAgent?.cwd).toBe(tmpDir);

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

      await newManager.killAgent(agentId);
    },
    120000
  );
});
