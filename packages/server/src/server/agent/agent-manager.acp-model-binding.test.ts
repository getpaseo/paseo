import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { ACPAgentClient, ACPAgentSession } from "./providers/acp-agent.js";

test("a qualified ACP model remains canonical in the manager, emitted snapshot, and saved record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-acp-model-binding-"));
  const logger = createTestLogger();
  const models = [
    { modelId: "vendor/source", name: "Source" },
    { modelId: "vendor/muse-spark", name: "Muse" },
  ];
  const setSessionModel = vi.fn(async () => ({}));
  class Client extends ACPAgentClient {
    override async isAvailable() {
      return true;
    }
    override async fetchCatalog() {
      return {
        models: models.map((model) => ({
          id: model.modelId,
          label: model.name,
          provider: "copilot",
        })),
        modes: [],
      };
    }
    override async createSession(config: AgentSessionConfig) {
      const session = new ACPAgentSession(config, {
        provider: "copilot",
        logger,
        defaultCommand: ["fake-acp"],
        defaultModes: [],
      });
      const internals = session as unknown as {
        sessionId: string;
        connection: unknown;
        availableModels: typeof models;
        currentModel: string;
      };
      internals.sessionId = "native-session";
      internals.connection = { unstable_setSessionModel: setSessionModel };
      internals.availableModels = models;
      internals.currentModel = "vendor/source";
      return session;
    }
  }
  const storage = new AgentStorage(join(cwd, "agents"), logger);
  const manager = new AgentManager({
    clients: { copilot: new Client({ provider: "copilot", logger, defaultCommand: ["fake-acp"] }) },
    registry: storage,
    logger,
  });
  try {
    const agent = await manager.createAgent(
      { provider: "copilot", cwd, model: "vendor/source" },
      undefined,
      { workspaceId: undefined },
    );
    await manager.setAgentModel(agent.id, "muse-spark");
    await manager.flush();
    expect(setSessionModel).toHaveBeenCalledWith({
      sessionId: "native-session",
      modelId: "vendor/muse-spark",
    });
    expect(manager.getAgent(agent.id)?.runtimeInfo?.model).toBe("vendor/muse-spark");
    expect(manager.getAgent(agent.id)?.config.model).toBe("vendor/muse-spark");
    expect((await storage.get(agent.id))?.config?.model).toBe("vendor/muse-spark");
  } finally {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await manager.flush();
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([
  ["change", "muse"],
  ["change", "missing"],
  ["create", "muse"],
  ["create", "missing"],
  ["create", "unique"],
])("ACP %s validates and persists the advertised identity for %s", async (operation, model) => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-acp-explicit-model-"));
  const logger = createTestLogger();
  const models = ["vendor/default", "first/muse", "second/muse", "vendor/unique"].map(
    (modelId) => ({ modelId, name: modelId }),
  );
  const setModel = vi.fn(async () => ({}));
  class Client extends ACPAgentClient {
    override async isAvailable() {
      return true;
    }
    override async fetchCatalog() {
      return {
        models: models.map((entry) => ({
          id: entry.modelId,
          label: entry.name,
          provider: "copilot",
        })),
        modes: [],
      };
    }
    override async createSession(config: AgentSessionConfig) {
      const session = new ACPAgentSession(config, {
        provider: "copilot",
        logger,
        defaultCommand: ["fake-acp"],
        defaultModes: [],
      });
      const internals = session as unknown as {
        sessionId: string;
        connection: unknown;
        availableModels: typeof models;
        currentModel: string;
        applyConfiguredOverrides(): Promise<void>;
      };
      internals.sessionId = "native-session";
      internals.connection = { unstable_setSessionModel: setModel };
      internals.availableModels = models;
      internals.currentModel = "vendor/default";
      await internals.applyConfiguredOverrides();
      return session;
    }
  }
  const storage = new AgentStorage(join(cwd, "agents"), logger);
  const manager = new AgentManager({
    clients: { copilot: new Client({ provider: "copilot", logger, defaultCommand: ["fake-acp"] }) },
    registry: storage,
    logger,
  });
  try {
    if (operation === "change") {
      const agent = await manager.createAgent(
        { provider: "copilot", cwd, model: "vendor/default" },
        undefined,
        { workspaceId: undefined },
      );
      await expect(manager.setAgentModel(agent.id, model)).rejects.toThrow(model);
      expect(setModel).not.toHaveBeenCalled();
      await manager.flush();
      expect(manager.getAgent(agent.id)?.config.model).toBe("vendor/default");
      expect((await storage.get(agent.id))?.config?.model).toBe("vendor/default");
    } else if (model === "unique") {
      const agent = await manager.createAgent({ provider: "copilot", cwd, model }, undefined, {
        workspaceId: undefined,
      });
      await manager.flush();
      expect(manager.getAgent(agent.id)?.runtimeInfo?.model).toBe("vendor/unique");
      expect(manager.getAgent(agent.id)?.config.model).toBe("vendor/unique");
      expect((await storage.get(agent.id))?.config?.model).toBe("vendor/unique");
    } else {
      await expect(
        manager.createAgent({ provider: "copilot", cwd, model }, undefined, {
          workspaceId: undefined,
        }),
      ).rejects.toThrow(model);
      expect(setModel).not.toHaveBeenCalled();
      expect(manager.listAgents()).toEqual([]);
    }
  } finally {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await manager.flush();
    await rm(cwd, { recursive: true, force: true });
  }
});
