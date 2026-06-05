import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ListModelsOptions,
  ResolveAgentCreateConfigInput,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

// Builds an AgentClient that can be injected via the public extraClients option.
// extraClients is the only injection surface the manager exposes for tests.
function createExtraClient(
  provider: AgentProvider,
  overrides: Partial<AgentClient> = {},
): AgentClient {
  return {
    provider,
    capabilities: TEST_CAPABILITIES,
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async listModels(_options: ListModelsOptions) {
      return [] as AgentModelDefinition[];
    },
    async isAvailable() {
      return false;
    },
    ...overrides,
  } satisfies AgentClient;
}

describe("ProviderSnapshotManager public surface", () => {
  test("listRegisteredProviderIds includes the built-in providers", () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const ids = manager.listRegisteredProviderIds();
      expect(ids).toEqual(expect.arrayContaining(["claude", "codex", "opencode", "copilot", "pi"]));
    } finally {
      manager.destroy();
    }
  });

  test("hasProvider reflects the built-in set and providerOverrides additions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      },
    });
    try {
      expect(manager.hasProvider("claude")).toBe(true);
      expect(manager.hasProvider("zai-claude")).toBe(true);
      expect(manager.hasProvider("not-a-provider" as AgentProvider)).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderLabel returns the override label when provided", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "qwen-codex": { extends: "codex", label: "Qwen Code", enabled: true },
      },
    });
    try {
      expect(manager.getProviderLabel("qwen-codex")).toBe("Qwen Code");
      expect(manager.getProviderLabel("claude")).toBe("Claude");
    } finally {
      manager.destroy();
    }
  });

  test("getSnapshot returns loading entries for built-in providers before warmup", () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const snapshot = manager.getSnapshot("/tmp/project");
      const claude = snapshot.find((entry) => entry.provider === "claude");
      expect(claude?.status).toBe("loading");
      expect(claude?.label).toBe("Claude");
      expect(claude?.defaultModeId).toBe("default");
    } finally {
      manager.destroy();
    }
  });

  test("providerOverrides with enabled:false marks the provider as unavailable without probing", async () => {
    const isAvailable = vi.fn(async () => true);
    const fetchModels = vi.fn(async () => [] as AgentModelDefinition[]);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, listModels: fetchModels }),
      },
    });
    try {
      const entries = await manager.listProviders({ cwd: "/tmp/project", wait: true });
      const codex = entries.find((entry) => entry.provider === "codex");
      expect(codex).toMatchObject({ provider: "codex", enabled: false, status: "unavailable" });
      expect(isAvailable).not.toHaveBeenCalled();
      expect(fetchModels).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("extraClients with isAvailable=false routes to unavailable without fetching", async () => {
    const isAvailable = vi.fn().mockResolvedValue(false);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.provider).toBe("codex");
      expect(entry.status).toBe("unavailable");
      expect(isAvailable).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("listProviders returns an entry per registered provider", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const entries = await manager.listProviders({ cwd: "/tmp/project", wait: true });
      const providers = entries.map((entry) => entry.provider).sort();
      expect(providers).toEqual(["claude", "codex", "copilot", "opencode", "pi"]);
      for (const entry of entries) {
        expect(entry.enabled).toBe(false);
        expect(entry.status).toBe("unavailable");
      }
    } finally {
      manager.destroy();
    }
  });

  test("getProvider throws when the provider is not configured", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.getProvider({
          cwd: "/tmp/project",
          provider: "not-a-provider" as AgentProvider,
          wait: true,
        }),
      ).rejects.toThrow(/not configured/);
    } finally {
      manager.destroy();
    }
  });

  test("listModels rejects when the provider is disabled", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.listModels({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).rejects.toThrow(/disabled/);
    } finally {
      manager.destroy();
    }
  });

  test("listModes rejects when the provider is disabled", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      await expect(
        manager.listModes({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).rejects.toThrow(/disabled/);
    } finally {
      manager.destroy();
    }
  });

  test("resolveDefaultModel returns the requested model verbatim when provided", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      const id = await manager.resolveDefaultModel({
        provider: "codex",
        requestedModel: "gpt-5.4",
        cwd: "/tmp/project",
      });
      expect(id).toBe("gpt-5.4");
    } finally {
      manager.destroy();
    }
  });

  test("resolveDefaultModel returns undefined when the provider is disabled and no override is given", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
    });
    try {
      const id = await manager.resolveDefaultModel({ provider: "codex", cwd: "/tmp/project" });
      expect(id).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic returns the diagnostic from the injected client", async () => {
    const getDiagnostic = vi.fn(async () => ({ diagnostic: "codex is ready" }));
    const client = createExtraClient("codex", { getDiagnostic });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result).toEqual({ provider: "codex", diagnostic: "codex is ready" });
      expect(getDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic falls back to a default message when the client has no getDiagnostic", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: createExtraClient("codex") },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toMatch(/no diagnostic/i);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic throws when no client is configured for the provider", async () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      await expect(manager.getProviderDiagnostic("codex")).rejects.toThrow(/not configured/);
    } finally {
      manager.destroy();
    }
  });

  test("getAgentManagerProviderState exposes extraClients verbatim", () => {
    const codexClient = createExtraClient("codex");
    const claudeClient = createExtraClient("claude");
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { opencode: { enabled: false }, copilot: { enabled: false } },
      extraClients: { codex: codexClient, claude: claudeClient },
    });
    try {
      const state = manager.getAgentManagerProviderState();
      expect(state.clients.codex).toBe(codexClient);
      expect(state.clients.claude).toBe(claudeClient);
      expect(state.providerDefinitions.opencode).toMatchObject({ enabled: false });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: true });
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig reduces a managed parent to provider mode and unattended data", async () => {
    const resolverInputs: ResolveAgentCreateConfigInput[] = [];
    const childModes: AgentMode[] = [
      { id: "child-unattended", label: "Child", isUnattended: true },
    ];
    const parentModes: AgentMode[] = [
      { id: "parent-unattended", label: "Parent", isUnattended: true },
    ];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async listModes() {
            return childModes;
          },
          async resolveCreateConfig(input) {
            resolverInputs.push(input);
            return {
              modeId: input.parent?.isUnattended ? "child-unattended" : undefined,
              featureValues: undefined,
            };
          },
        }),
        claude: createExtraClient("claude", {
          async isAvailable() {
            return true;
          },
          async listModes() {
            return parentModes;
          },
          isCreateConfigUnattended(input) {
            return input.modeId === "parent-unattended";
          },
        }),
      },
    });
    try {
      const parent = {
        id: "parent-agent",
        provider: "claude",
        currentModeId: "parent-unattended",
        availableModes: parentModes,
        config: { provider: "claude", cwd: "/tmp/project" },
      } as ManagedAgent;

      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "codex",
        requestedMode: undefined,
        featureValues: undefined,
        parent,
        unattended: false,
      });

      expect(resolved).toEqual({ modeId: "child-unattended", featureValues: undefined });
      expect(resolverInputs).toEqual([
        {
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: {
            provider: "claude",
            modeId: "parent-unattended",
            isUnattended: true,
          },
          unattended: true,
          availableModes: childModes,
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig passes explicit unattended intent to provider policy", async () => {
    const resolverInputs: ResolveAgentCreateConfigInput[] = [];
    const modes: AgentMode[] = [{ id: "worker", label: "Worker", isUnattended: true }];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async listModes() {
            return modes;
          },
          async resolveCreateConfig(input) {
            resolverInputs.push(input);
            return {
              modeId: input.unattended ? "worker" : undefined,
              featureValues: undefined,
            };
          },
        }),
      },
    });
    try {
      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "codex",
        requestedMode: undefined,
        featureValues: { fast_mode: true },
        parent: null,
        unattended: true,
      });

      expect(resolved).toEqual({ modeId: "worker", featureValues: undefined });
      expect(resolverInputs).toEqual([
        {
          provider: "codex",
          requestedMode: undefined,
          featureValues: { fast_mode: true },
          parent: null,
          unattended: true,
          availableModes: modes,
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("treats an OpenCode parent with auto accept as unattended when resolving an explicit child mode", async () => {
    const openCode = new OpenCodeAgentClient(createTestLogger());
    const modes: AgentMode[] = [
      { id: "build", label: "Build" },
      { id: "base", label: "Base" },
      { id: "orchestrator", label: "Orchestrator" },
    ];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        opencode: createExtraClient("opencode", {
          async isAvailable() {
            return true;
          },
          async listModes() {
            return modes;
          },
          resolveCreateConfig: openCode.resolveCreateConfig.bind(openCode),
          isCreateConfigUnattended: openCode.isCreateConfigUnattended.bind(openCode),
        }),
      },
    });
    try {
      const parent = {
        id: "parent-agent",
        provider: "opencode",
        currentModeId: "orchestrator",
        availableModes: modes,
        config: {
          provider: "opencode",
          cwd: "/tmp/project",
          featureValues: { auto_accept: true },
        },
      } as ManagedAgent;

      const resolved = await manager.resolveCreateConfig({
        cwd: "/tmp/project",
        provider: "opencode",
        requestedMode: "base",
        featureValues: undefined,
        parent,
        unattended: false,
      });

      expect(resolved).toEqual({ modeId: "base", featureValues: { auto_accept: true } });
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager applyMutableProviderConfig", () => {
  test("adds a derived provider and includes it in subsequent reads", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      expect(manager.hasProvider("zai-claude")).toBe(false);

      const state = manager.applyMutableProviderConfig({
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      });

      expect(manager.hasProvider("zai-claude")).toBe(true);
      expect(state.providerDefinitions["zai-claude"]).toMatchObject({ enabled: true });
      expect(manager.listRegisteredProviderIds()).toContain("zai-claude");
    } finally {
      manager.destroy();
    }
  });

  test("drops disabled built-in providers from clients while preserving providerDefinitions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: true },
        codex: { enabled: true },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const before = manager.getAgentManagerProviderState();
      expect(before.providerDefinitions.copilot).toMatchObject({ enabled: false });
      expect(before.clients.copilot).toBeUndefined();

      const state = manager.applyMutableProviderConfig({ codex: { enabled: false } });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: false });
      expect(state.clients.codex).toBeUndefined();
      expect(state.providerDefinitions.copilot).toMatchObject({ enabled: false });
      expect(state.clients.copilot).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("fires a change event on every primed snapshot cwd after applyMutableProviderConfig", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);

      // Prime two distinct cwd snapshots. resolve() makes the keys platform-
      // native so Windows ("D:\\tmp\\...") matches the assertion below.
      const cwdA = resolve("/tmp/project-a");
      const cwdB = resolve("/tmp/project-b");
      manager.getSnapshot(cwdA);
      manager.getSnapshot(cwdB);

      listener.mockClear();
      manager.applyMutableProviderConfig({
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      });

      const cwds = listener.mock.calls.map((call) => call[1]).sort();
      expect(cwds).toEqual([cwdA, cwdB].sort());
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager lifecycle", () => {
  test("on/off attaches and detaches change listeners", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);
      manager.getSnapshot("/tmp/project");
      manager.applyMutableProviderConfig({});
      const firstCallCount = listener.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      manager.off("change", listener);
      manager.applyMutableProviderConfig({});
      expect(listener.mock.calls.length).toBe(firstCallCount);
    } finally {
      manager.destroy();
    }
  });

  test("destroy clears snapshots and prevents further change emissions", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    const listener = vi.fn();
    manager.on("change", listener);
    manager.getSnapshot("/tmp/project");
    manager.destroy();

    listener.mockClear();
    manager.applyMutableProviderConfig({});
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ProviderSnapshotManager cwd routing", () => {
  test("different cwd keys produce independent snapshots", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const a = manager.getSnapshot("/tmp/project-a");
      const b = manager.getSnapshot("/tmp/project-b");
      expect(a).not.toBe(b);
      expect(a.map((entry) => entry.provider).sort()).toEqual(
        b.map((entry) => entry.provider).sort(),
      );
    } finally {
      manager.destroy();
    }
  });

  test("getSnapshot called with no cwd resolves to the home snapshot key", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const listener = vi.fn();
      manager.on("change", listener);
      manager.getSnapshot();
      manager.applyMutableProviderConfig({});
      const cwds = listener.mock.calls.map((call) => call[1]);
      // applyMutableProviderConfig emits change for each primed cwd; the home
      // snapshot must be present.
      expect(cwds.length).toBeGreaterThanOrEqual(1);
      for (const cwd of cwds) {
        expect(typeof cwd).toBe("string");
        expect(cwd.length).toBeGreaterThan(0);
      }
    } finally {
      manager.destroy();
    }
  });
});
