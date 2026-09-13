import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import type { AgentClient, AgentLaunchContext, AgentSessionConfig } from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { assertWritePolicySupported, supportsWritePolicy } from "./write-policy.js";

test.each(["omp", "claude", "opencode", "copilot", "pi", "acp", "custom-codex"])(
  "read-only rejects %s before availability checks or startup",
  async (provider) => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-write-policy-"));
    const calls: string[] = [];
    const client = {
      provider,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      isAvailable: async () => {
        calls.push("availability");
        return true;
      },
      createSession: async () => {
        calls.push("startup");
        throw new Error("Provider was started");
      },
    } as unknown as AgentClient;
    const manager = new AgentManager({
      clients: { [provider]: client },
      logger: createTestLogger(),
    });
    try {
      await expect(
        manager.createAgent({ provider, cwd, model: "test", writePolicy: "read_only" }, undefined, {
          workspaceId: undefined,
        }),
      ).rejects.toMatchObject({ code: "write_policy_unsupported", provider });
      expect(calls).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("unsupported hosts fail closed while OMP read-write stays supported", () => {
  expect(supportsWritePolicy("omp", "read_write")).toBe(true);
  vi.stubGlobal("process", { ...process, platform: "linux" });
  try {
    expect(supportsWritePolicy("codex", "read_only")).toBe(false);
    expect(() =>
      assertWritePolicySupported({ provider: "codex", writePolicy: "read_only" }),
    ).toThrow("cannot enforce read_only");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("deleting an agent removes only its owned read-only state", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-readonly-cleanup-"));
  vi.stubEnv("PASEO_HOME", root);
  const agentId = "a3a4635f-02d3-44c5-87f2-e232cb1c3ffb";
  const own = join(root, "codex-read-only", agentId);
  const neighbor = join(root, "codex-read-only", "another-agent");
  await mkdir(own, { recursive: true });
  await mkdir(neighbor, { recursive: true });
  await writeFile(join(own, "internal"), "fixture");
  const manager = new AgentManager({ clients: {}, logger: createTestLogger() });
  try {
    await manager.deleteAgentState(agentId);
    await expect(access(own)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(neighbor)).resolves.toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "read-only skips unconfined catalog probes and removes all MCP injection",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-write-policy-"));
    const calls: string[] = [];
    let launchConfig: AgentSessionConfig | undefined;
    let context: AgentLaunchContext | undefined;
    const client = {
      provider: "codex",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsNativePaseoTools: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      isAvailable: async () => true,
      fetchCatalog: async () => {
        calls.push("catalog");
        return { models: [], modes: [] };
      },
      createSession: async (config: AgentSessionConfig, launchContext: AgentLaunchContext) => {
        launchConfig = config;
        context = launchContext;
        throw new Error("Captured launch");
      },
    } as unknown as AgentClient;
    const manager = new AgentManager({
      clients: { codex: client },
      logger: createTestLogger(),
      mcpBaseUrl: "http://localhost:6767/mcp",
      mcpAuthToken: "fixture-only",
      paseoToolsEnabled: true,
      paseoToolCatalogFactory: () => {
        calls.push("paseo-tools");
        throw new Error("Paseo catalog must not be created");
      },
    });

    try {
      await expect(
        manager.createAgent(
          {
            provider: "codex",
            cwd,
            writePolicy: "read_only",
            mcpServers: { writer: { type: "stdio", command: "/bin/echo" } },
          },
          undefined,
          { workspaceId: undefined },
        ),
      ).rejects.toThrow("Captured launch");
      expect(calls).toEqual([]);
      expect(launchConfig?.mcpServers).toEqual({});
      expect(context?.paseoTools).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "read-only remains immutable through reload and daemon restoration and has no Paseo tools",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-readonly-lifecycle-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(join(root, "agents"), logger);
    const clients = createTestAgentClients();
    const create = clients.codex!.createSession.bind(clients.codex);
    const resume = clients.codex!.resumeSession.bind(clients.codex);
    clients.codex!.createSession = async (config, ...args) => {
      const session = await create(config, ...args);
      const describe = session.describePersistence.bind(session);
      session.describePersistence = () => {
        const handle = describe();
        return handle ? { ...handle, metadata: { ...handle.metadata, ...config } } : null;
      };
      return session;
    };
    clients.codex!.resumeSession = async (handle, config, ...args) => {
      const session = await resume(handle, config, ...args);
      const describe = session.describePersistence.bind(session);
      session.describePersistence = () => {
        const next = describe();
        return next ? { ...next, metadata: { ...next.metadata, ...config } } : null;
      };
      return session;
    };
    const manager = new AgentManager({ clients, registry: storage, logger });
    const restoredManager = new AgentManager({ clients, registry: storage, logger });
    try {
      const agent = await manager.createAgent(
        { provider: "codex", cwd: root, model: "test", writePolicy: "read_only" },
        undefined,
        { workspaceId: undefined },
      );
      const catalog = createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub(),
        logger,
        callerAgentId: agent.id,
      });
      expect([...catalog.tools.keys()]).toEqual([]);
      await expect(catalog.executeTool("create_terminal", {})).rejects.toThrow(
        "Paseo tool not found",
      );
      await expect(
        manager.reloadAgentSession(agent.id, { writePolicy: "read_write" }),
      ).rejects.toThrow("creation-only");
      const refreshed = await manager.reloadAgentSession(agent.id, { writePolicy: undefined });
      expect(refreshed.config.writePolicy).toBe("read_only");
      await manager.closeAgent(agent.id);
      await manager.flush();
      await storage.flush();
      expect((await storage.get(agent.id))?.config?.writePolicy).toBe("read_only");
      const restored = await ensureAgentLoaded(agent.id, {
        agentManager: restoredManager,
        agentStorage: storage,
        logger,
      });
      expect(restored.config.writePolicy).toBe("read_only");
      await expect(
        restoredManager.resumeAgentFromPersistence(restored.persistence!, {
          writePolicy: "read_write",
        }),
      ).rejects.toThrow("creation-only");
    } finally {
      for (const owner of [manager, restoredManager]) {
        owner.prepareForShutdown();
        await Promise.all(owner.listAgents().map((agent) => owner.closeAgent(agent.id)));
        await owner.flushForShutdown();
      }
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);
