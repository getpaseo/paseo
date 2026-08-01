import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  FetchCatalogOptions,
  ResolveAgentCreateConfigInput,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
  resolveSnapshotCwd,
} from "./provider-snapshot-manager.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";
import { createShutdownDeadline } from "../../utils/shutdown-deadline.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;
const TEST_REFRESH_TIMEOUT_MS = 120_000;

function createDeferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolvePromise = fulfill;
  });
  return { promise, resolve: resolvePromise };
}

function rejectWhenAborted(signal: AbortSignal, reject: (reason?: unknown) => void): void {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}

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
    async fetchCatalog(_options: FetchCatalogOptions) {
      return { models: [] as AgentModelDefinition[], modes: [] as AgentMode[] };
    },
    async isAvailable() {
      return false;
    },
    ...overrides,
  } satisfies AgentClient;
}

async function withEnv(key: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("ProviderSnapshotManager public surface", () => {
  test("listRegisteredProviderIds includes the built-in providers", () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const ids = manager.listRegisteredProviderIds();
      expect(ids).toEqual(
        expect.arrayContaining(["claude", "codex", "opencode", "copilot", "pi", "omp"]),
      );
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
      const codex = snapshot.find((entry) => entry.provider === "codex");
      expect(claude?.status).toBe("loading");
      expect(claude?.label).toBe("Claude");
      expect(claude?.defaultModeId).toBe("auto");
      expect(codex?.defaultModeId).toBe("auto-review");
    } finally {
      manager.destroy();
    }
  });

  test("providerOverrides with enabled:false marks the provider as unavailable without probing", async () => {
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
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
        codex: createExtraClient("codex", { isAvailable, fetchCatalog }),
      },
    });
    try {
      const entries = await manager.listProviders({ cwd: "/tmp/project", wait: true });
      const codex = entries.find((entry) => entry.provider === "codex");
      expect(codex).toMatchObject({ provider: "codex", enabled: false, status: "unavailable" });
      expect(isAvailable).not.toHaveBeenCalled();
      expect(fetchCatalog).not.toHaveBeenCalled();
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

  test("wait:true returns a warm provider without refreshing it", async () => {
    const cwd = "/tmp/project";
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "codex",
          id: "gpt-5.4-mini",
          label: "GPT 5.4 Mini",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog }),
      },
    });
    const listener = vi.fn();
    manager.on("change", listener);
    try {
      const [first] = await manager.listProviders({ cwd, providers: ["codex"], wait: true });
      expect(first).toMatchObject({ provider: "codex", status: "ready" });
      expect(isAvailable).toHaveBeenCalledTimes(1);
      expect(fetchCatalog).toHaveBeenCalledTimes(1);

      listener.mockClear();
      const [second] = await manager.listProviders({ cwd, providers: ["codex"], wait: true });

      expect(second).toEqual(first);
      expect(isAvailable).toHaveBeenCalledTimes(1);
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("ready snapshots publish the catalog's capability-aware default mode", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [],
            modes: [{ id: "default", label: "Default", description: "Ask before running tools" }],
            defaultModeId: "default",
          }),
        }),
      },
    });

    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });

      expect(entry).toMatchObject({ status: "ready", defaultModeId: "default" });
    } finally {
      manager.destroy();
    }
  });

  test("explicit refresh re-probes only the requested warm provider", async () => {
    const cwd = "/tmp/project";
    const isAvailableCodex = vi.fn(async () => true);
    const fetchCodexCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "codex",
          id: "gpt-5.4-mini",
          label: "GPT 5.4 Mini",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const isAvailableClaude = vi.fn(async () => true);
    const fetchClaudeCatalog = vi.fn(async () => ({
      models: [
        {
          provider: "claude",
          id: "claude-opus-4.5",
          label: "Claude Opus 4.5",
        },
      ] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: isAvailableCodex,
          fetchCatalog: fetchCodexCatalog,
        }),
        claude: createExtraClient("claude", {
          isAvailable: isAvailableClaude,
          fetchCatalog: fetchClaudeCatalog,
        }),
      },
    });
    try {
      await manager.listProviders({ cwd, providers: ["codex", "claude"], wait: true });
      await manager.refreshSnapshotForCwd({ cwd, providers: ["codex"] });

      expect(isAvailableCodex).toHaveBeenCalledTimes(2);
      expect(fetchCodexCatalog).toHaveBeenCalledTimes(2);
      expect(isAvailableClaude).toHaveBeenCalledTimes(1);
      expect(fetchClaudeCatalog).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("refreshTimeoutMs option overrides the default and yields a timeout error", async () => {
    // never-resolving isAvailable forces the timeout path
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
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
      expect(entry.status).toBe("error");
      expect(entry.error).toMatch(/after 1ms/);
    } finally {
      manager.destroy();
    }
  });

  test("PASEO_PROVIDER_REFRESH_TIMEOUT_MS env var is honored when no option is given", async () => {
    vi.stubEnv("PASEO_PROVIDER_REFRESH_TIMEOUT_MS", "1");
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
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
      expect(entry.status).toBe("error");
      expect(entry.error).toMatch(/after 1ms/);
    } finally {
      manager.destroy();
      vi.unstubAllEnvs();
    }
  });

  test("PASEO_PROVIDER_REFRESH_TIMEOUT_MS env var is ignored when option is provided", async () => {
    vi.stubEnv("PASEO_PROVIDER_REFRESH_TIMEOUT_MS", "1");
    const isAvailable = vi.fn(() => new Promise<boolean>(() => {}));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 5,
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
      expect(entry.status).toBe("error");
      // explicit option (5) wins over env var (1)
      expect(entry.error).toMatch(/after 5ms/);
    } finally {
      manager.destroy();
      vi.unstubAllEnvs();
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
      expect(providers).toEqual(["claude", "codex", "copilot", "omp", "opencode", "pi"]);
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

  test("getProviderDiagnostic returns the diagnostic from the injected client and appends snapshot models/status", async () => {
    const getDiagnostic = vi.fn(async () => ({ diagnostic: "codex is ready" }));
    const client = createExtraClient("codex", { getDiagnostic });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toContain("codex is ready");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
      expect(getDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic force-refreshes the snapshot and appends models/status", async () => {
    const catalogModels: AgentModelDefinition[] = [
      { provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
    ];
    const catalogModes: AgentMode[] = [{ id: "agent", label: "Agent" }];
    const fetchCatalog = vi.fn(async () => ({
      models: catalogModels,
      modes: catalogModes,
    }));
    const client = createExtraClient("codex", {
      isAvailable: async () => true,
      fetchCatalog,
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: true });
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic falls back to a default message when the client has no getDiagnostic and appends snapshot models/status", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: createExtraClient("codex") },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toMatch(/no diagnostic/i);
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic materializes the client and proceeds for an unmaterialized configured provider", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      isDev: true,
      extraClients: {},
    });
    try {
      const result = await manager.getProviderDiagnostic("mock");
      expect(result.provider).toBe("mock");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic turns provider diagnostic failures into diagnostic text", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
            modes: [] as AgentMode[],
          }),
          getDiagnostic: async () => {
            throw new Error("diagnostic probe exploded");
          },
        }),
      },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.diagnostic).toContain("Error: diagnostic probe exploded");
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic starts provider diagnostics before waiting for snapshot refresh", async () => {
    vi.useFakeTimers();
    let diagnosticStarted = false;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => new Promise(() => {}),
          getDiagnostic: async () => {
            diagnosticStarted = true;
            return { diagnostic: "codex diagnostics available" };
          },
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      expect(diagnosticStarted).toBe(true);

      const diagnosticOrBlocked = Promise.race([
        diagnosticRequest.then(() => ({ type: "diagnostic" as const })),
        new Promise<{ type: "blocked" }>((finish) => {
          setTimeout(() => finish({ type: "blocked" }), 1);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(diagnosticOrBlocked).resolves.toEqual({ type: "blocked" });

      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS - 1);
      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain("codex diagnostics available");
      expect(result.diagnostic).toContain(
        `Status: Error: Timed out refreshing Codex after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic starts snapshot refresh even when provider diagnostics hang", async () => {
    vi.useFakeTimers();
    let diagnosticStarted = false;
    let snapshotStarted = false;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => {
            snapshotStarted = true;
            return new Promise(() => {});
          },
          getDiagnostic: async () => {
            diagnosticStarted = true;
            return new Promise(() => {});
          },
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      await vi.advanceTimersByTimeAsync(0);

      expect(diagnosticStarted).toBe(true);
      expect(snapshotStarted).toBe(true);

      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);
      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain(
        `Error: Timed out collecting Codex diagnostic after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
      expect(result.diagnostic).toContain(
        `Status: Error: Timed out refreshing Codex after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic reports provider diagnostic timeout while preserving snapshot details", async () => {
    vi.useFakeTimers();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
            modes: [] as AgentMode[],
          }),
          getDiagnostic: async () => new Promise(() => {}),
        }),
      },
    });
    try {
      const diagnosticRequest = manager.getProviderDiagnostic("codex");
      await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);

      const result = await diagnosticRequest;
      expect(result.diagnostic).toContain(
        `Error: Timed out collecting Codex diagnostic after ${TEST_REFRESH_TIMEOUT_MS}ms`,
      );
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("getProviderDiagnostic reports a stuck catalog refresh inside the diagnostic", async () => {
    await withEnv("PASEO_ENABLE_MOCK_SLOW", "true", async () => {
      vi.useFakeTimers();
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        isDev: true,
        refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      });
      try {
        const diagnosticRequest = manager.getProviderDiagnostic("mock-slow");
        await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);

        const result = await diagnosticRequest;
        expect(result.provider).toBe("mock-slow");
        expect(result.diagnostic).toContain("Mock slow provider");
        expect(result.diagnostic).toContain("Models: —");
        expect(result.diagnostic).toContain(
          `Status: Error: Timed out refreshing Mock Slow Provider after ${TEST_REFRESH_TIMEOUT_MS}ms`,
        );
      } finally {
        manager.destroy();
        vi.useRealTimers();
      }
    });
  });

  test("getProviderDiagnostic returns an error diagnostic for an unknown provider", async () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      await expect(manager.getProviderDiagnostic("unknown-provider" as AgentProvider)).resolves
        .toMatchInlineSnapshot(`
          {
            "diagnostic": "unknown-provider
            Error: Provider unknown-provider is not configured",
            "provider": "unknown-provider",
          }
        `);
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
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: childModes };
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
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: parentModes };
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
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
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
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
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
      expect(manager.getSnapshot().find((entry) => entry.provider === "zai-claude")?.source).toBe(
        "custom",
      );
    } finally {
      manager.destroy();
    }
  });

  test("removes startup provider overrides from the live registry", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "zai-claude": { extends: "claude", label: "ZAI", enabled: true },
      },
    });
    try {
      expect(manager.hasProvider("zai-claude")).toBe(true);

      const state = manager.applyMutableProviderConfig({}, { removeProviders: ["zai-claude"] });

      expect(manager.hasProvider("zai-claude")).toBe(false);
      expect(state.providerDefinitions["zai-claude"]).toBeUndefined();
      expect(manager.getSnapshot().some((entry) => entry.provider === "zai-claude")).toBe(false);

      manager.applyMutableProviderConfig({ codex: { enabled: false } });
      expect(manager.hasProvider("zai-claude")).toBe(false);
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
  test("shutdown immediately demotes snapshots and rejects new provider probes", async () => {
    const shutdownGate = createDeferred<void>();
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [{ id: "codex-ready", name: "Codex Ready" }],
      modes: [] as AgentMode[],
    }));
    const shutdown = vi.fn(async () => shutdownGate.promise);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog, shutdown }),
      },
    });
    let shutdownPromise: Promise<void> | undefined;

    try {
      const cwd = "/tmp/project";
      await manager.listProviders({ cwd, providers: ["codex"], wait: true });
      isAvailable.mockClear();
      fetchCatalog.mockClear();

      shutdownPromise = manager.shutdown();

      expect(manager.getSnapshot(cwd).find((entry) => entry.provider === "codex")).toMatchObject({
        status: "unavailable",
        enabled: true,
        error: "Provider runtime is shutting down",
      });
      expect(
        manager.getSnapshot("/tmp/new-project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        enabled: true,
        error: "Provider runtime is shutting down",
      });
      await expect(manager.refreshSnapshotForCwd({ cwd, providers: ["codex"] })).rejects.toThrow(
        "Provider runtime is shutting down",
      );
      await expect(
        manager.resolveCreateConfig({
          cwd,
          provider: "codex",
          requestedMode: undefined,
          featureValues: undefined,
          parent: null,
          unattended: false,
        }),
      ).rejects.toThrow("Provider runtime is shutting down");
      expect(isAvailable).not.toHaveBeenCalled();
      expect(fetchCatalog).not.toHaveBeenCalled();
    } finally {
      shutdownGate.resolve();
      await shutdownPromise;
      manager.destroy();
    }
  });

  test("shutdown is idempotent and completed shutdown remains definitively unavailable", async () => {
    const shutdown = vi.fn(async () => {});
    const isAvailable = vi.fn(async () => true);
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, fetchCatalog, shutdown }),
      },
    });

    try {
      await Promise.all([manager.shutdown(), manager.shutdown()]);
      isAvailable.mockClear();
      fetchCatalog.mockClear();

      const entries = await manager.listProviders({
        cwd: "/tmp/project",
        providers: ["codex"],
        wait: true,
      });

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(entries[0]).toMatchObject({
        status: "unavailable",
        enabled: true,
        error: "Provider runtime has shut down",
      });
      expect(isAvailable).not.toHaveBeenCalled();
      expect(fetchCatalog).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("shutdown prevents an in-flight availability probe from starting a catalog request", async () => {
    const availabilityGate = createDeferred<boolean>();
    const isAvailable = vi.fn(async () => availabilityGate.promise);
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
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
          isAvailable,
          fetchCatalog,
          shutdown: vi.fn(async () => {}),
        }),
      },
    });

    try {
      const refreshPromise = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await vi.waitFor(() => expect(isAvailable).toHaveBeenCalledTimes(1));

      const shutdownPromise = manager.shutdown();
      await Promise.resolve();
      expect(fetchCatalog).not.toHaveBeenCalled();
      availabilityGate.resolve(true);
      await shutdownPromise;
      await refreshPromise;

      expect(fetchCatalog).not.toHaveBeenCalled();
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      availabilityGate.resolve(false);
      manager.destroy();
    }
  });

  test("shutdown aborts a cooperative availability probe before draining its client", async () => {
    let availabilitySignal: AbortSignal | undefined;
    const availabilityEntered = createDeferred<void>();
    const shutdown = vi.fn(async () => {});
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
          isAvailable: vi.fn(
            async (options) =>
              await new Promise<boolean>((_resolve, reject) => {
                availabilitySignal = options?.signal;
                availabilityEntered.resolve();
                if (availabilitySignal) rejectWhenAborted(availabilitySignal, reject);
              }),
          ),
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await availabilityEntered.promise;

      const shutdownPromise = manager.shutdown();
      await shutdownPromise;
      await refresh;

      expect(availabilitySignal?.aborted).toBe(true);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("a forced refresh aborts and drains the superseded availability probe", async () => {
    const availabilitySignals: AbortSignal[] = [];
    const shutdown = vi.fn(async () => {});
    const isAvailable = vi.fn(async (options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      if (!signal) return await new Promise<boolean>(() => {});
      availabilitySignals.push(signal);
      if (availabilitySignals.length === 2) return false;
      return await new Promise<boolean>((_resolve, reject) => rejectWhenAborted(signal, reject));
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { isAvailable, shutdown }),
      },
    });

    try {
      const first = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await vi.waitFor(() => expect(availabilitySignals).toHaveLength(1));

      const second = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await Promise.all([first, second]);

      expect(availabilitySignals).toHaveLength(2);
      expect(availabilitySignals[0]?.aborted).toBe(true);
      expect(availabilitySignals[1]?.aborted).toBe(false);
      await manager.shutdown();
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("shutdown cancels an in-flight catalog before its provider request survives", async () => {
    const catalogEntered = createDeferred<void>();
    const catalogGate = createDeferred<void>();
    const providerRequest = vi.fn();
    const fetchCatalog = vi.fn(async (options: FetchCatalogOptions) => {
      catalogEntered.resolve();
      await catalogGate.promise;
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      providerRequest();
      return {
        models: [] as AgentModelDefinition[],
        modes: [] as AgentMode[],
      };
    });
    const shutdown = vi.fn(async () => {});
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
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
          shutdown,
        }),
      },
    });

    try {
      const refreshPromise = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await catalogEntered.promise;

      const shutdownPromise = manager.shutdown();
      await Promise.resolve();
      expect(shutdown).not.toHaveBeenCalled();
      catalogGate.resolve();
      await shutdownPromise;
      await refreshPromise;

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(providerRequest).not.toHaveBeenCalled();
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      catalogGate.resolve();
      manager.destroy();
    }
  });

  test("catalog timeout aborts the probe but retains client ownership until the probe settles", async () => {
    const catalogEntered = createDeferred<void>();
    const catalogGate = createDeferred<void>();
    let catalogSignal: AbortSignal | undefined;
    const shutdown = vi.fn(async () => {});
    const fetchCatalog = vi.fn(async (options: FetchCatalogOptions) => {
      catalogSignal = options.signal;
      catalogEntered.resolve();
      await catalogGate.promise;
      throw options.signal?.reason;
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await catalogEntered.promise;
      await refresh;

      expect(catalogSignal?.aborted).toBe(true);
      const shutdownPromise = manager.shutdown();
      await Promise.resolve();
      expect(shutdown).not.toHaveBeenCalled();

      catalogGate.resolve();
      await shutdownPromise;

      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      catalogGate.resolve();
      manager.destroy();
    }
  });

  test("availability timeout aborts the probe but retains client ownership until it settles", async () => {
    const availabilityEntered = createDeferred<void>();
    const availabilityGate = createDeferred<boolean>();
    let availabilitySignal: AbortSignal | undefined;
    const shutdown = vi.fn(async () => {});
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async (options) => {
            availabilitySignal = options?.signal;
            availabilityEntered.resolve();
            return await availabilityGate.promise;
          }),
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await availabilityEntered.promise;
      await refresh;

      expect(availabilitySignal?.aborted).toBe(true);
      const shutdownPromise = manager.shutdown();
      await Promise.resolve();
      expect(shutdown).not.toHaveBeenCalled();

      availabilityGate.resolve(false);
      await shutdownPromise;

      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      availabilityGate.resolve(false);
      manager.destroy();
    }
  });

  test("shutdown terminalizes a never-settling availability probe within the drain bound", async () => {
    vi.useFakeTimers();
    const availabilityEntered = createDeferred<void>();
    const shutdown = vi.fn(async () => {});
    const laterCleanup = vi.fn();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => {
            availabilityEntered.resolve();
            return await new Promise<boolean>(() => {});
          }),
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await availabilityEntered.promise;
      await vi.advanceTimersByTimeAsync(1);
      await refresh;

      const shutdownAndLaterCleanup = manager
        .shutdown(createShutdownDeadline(8_000, () => Date.now()))
        .then(laterCleanup);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(shutdown).not.toHaveBeenCalled();
      expect(laterCleanup).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await shutdownAndLaterCleanup;

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(laterCleanup).toHaveBeenCalledTimes(1);
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("shutdown terminalizes a never-settling catalog probe within the drain bound", async () => {
    vi.useFakeTimers();
    const catalogEntered = createDeferred<void>();
    const shutdown = vi.fn(async () => {});
    const laterCleanup = vi.fn();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog: vi.fn(async () => {
            catalogEntered.resolve();
            return await new Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>(
              () => {},
            );
          }),
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await catalogEntered.promise;
      await vi.advanceTimersByTimeAsync(1);
      await refresh;

      const shutdownAndLaterCleanup = manager
        .shutdown(createShutdownDeadline(8_000, () => Date.now()))
        .then(laterCleanup);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(shutdown).not.toHaveBeenCalled();
      expect(laterCleanup).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await shutdownAndLaterCleanup;

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(laterCleanup).toHaveBeenCalledTimes(1);
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("stages noncooperative provider-load and client cleanup inside one eight-second budget", async () => {
    vi.useFakeTimers();
    const availabilityEntered = createDeferred<void>();
    const clientShutdownEntered = createDeferred<void>();
    const shutdown = vi.fn(async () => {
      clientShutdownEntered.resolve();
      return await new Promise<void>(() => {});
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => {
            availabilityEntered.resolve();
            return await new Promise<boolean>(() => {});
          }),
          shutdown,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await availabilityEntered.promise;
      await vi.advanceTimersByTimeAsync(1);
      await refresh;

      let shutdownSettled = false;
      const managerShutdown = manager
        .shutdown(createShutdownDeadline(8_000, () => Date.now()))
        .then(() => {
          shutdownSettled = true;
          return undefined;
        });
      await vi.advanceTimersByTimeAsync(2_499);
      expect(shutdown).not.toHaveBeenCalled();
      expect(shutdownSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await clientShutdownEntered.promise;
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(shutdownSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(5_499);
      expect(shutdownSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await managerShutdown;
      expect(shutdownSettled).toBe(true);
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("overlapping forced loads remain tracked and every generation aborts on shutdown", async () => {
    const catalogSignals: AbortSignal[] = [];
    const fetchCatalog = vi.fn(
      async (options: FetchCatalogOptions) =>
        await new Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>(
          (_resolve, reject) => {
            const signal = options.signal!;
            catalogSignals.push(signal);
            rejectWhenAborted(signal, reject);
          },
        ),
    );
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
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
          shutdown: vi.fn(async () => {}),
        }),
      },
    });

    try {
      const first = manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      await vi.waitFor(() => expect(catalogSignals).toHaveLength(1));
      const second = manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      await vi.waitFor(() => expect(catalogSignals).toHaveLength(2));
      const third = manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      await vi.waitFor(() => expect(catalogSignals).toHaveLength(3));

      await manager.shutdown();
      await Promise.all([first, second, third]);

      expect(catalogSignals.map((signal) => signal.aborted)).toEqual([true, true, true]);
    } finally {
      manager.destroy();
    }
  });

  test("provider config replacement aborts an active load before deleting its cache key", async () => {
    let catalogSignal: AbortSignal | undefined;
    const fetchCatalog = vi.fn(
      async (options: FetchCatalogOptions) =>
        await new Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>(
          (_resolve, reject) => {
            catalogSignal = options.signal;
            if (options.signal) rejectWhenAborted(options.signal, reject);
          },
        ),
    );
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
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });

    try {
      const refresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await vi.waitFor(() => expect(catalogSignal).toBeDefined());

      manager.applyMutableProviderConfig({ codex: { enabled: false } });
      await refresh;

      expect(catalogSignal?.aborted).toBe(true);
    } finally {
      manager.destroy();
    }
  });

  test("settings cache refresh aborts active loads before clearing cached provider keys", async () => {
    let firstSignal: AbortSignal | undefined;
    let callCount = 0;
    const fetchCatalog = vi.fn(async (options: FetchCatalogOptions) => {
      callCount += 1;
      if (callCount > 1) {
        return { models: [] as AgentModelDefinition[], modes: [] as AgentMode[] };
      }
      return await new Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>(
        (_resolve, reject) => {
          firstSignal = options.signal;
          if (options.signal) rejectWhenAborted(options.signal, reject);
        },
      );
    });
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
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });

    try {
      const workspaceRefresh = manager.refreshSnapshotForCwd({
        cwd: "/tmp/project",
        providers: ["codex"],
      });
      await vi.waitFor(() => expect(firstSignal).toBeDefined());

      await manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await workspaceRefresh;

      expect(firstSignal?.aborted).toBe(true);
    } finally {
      manager.destroy();
    }
  });

  test("throwing shutdown observers cannot skip provider client cleanup", async () => {
    const shutdown = vi.fn(async () => {});
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { shutdown }),
      },
    });

    try {
      manager.getSnapshot("/tmp/project");
      manager.on("change", () => {
        throw new Error("observer failed");
      });

      await expect(manager.shutdown()).resolves.toBeUndefined();

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      manager.destroy();
    }
  });

  test("reentrant repeated shutdown shares the published cleanup operation", async () => {
    const shutdownGate = createDeferred<void>();
    const shutdown = vi.fn(async () => shutdownGate.promise);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
        codex: createExtraClient("codex", { shutdown }),
      },
    });
    const reentrantShutdowns: Promise<void>[] = [];

    try {
      manager.getSnapshot("/tmp/project");
      manager.on("change", () => {
        reentrantShutdowns.push(manager.shutdown());
      });

      const firstShutdown = manager.shutdown();
      const repeatedShutdown = manager.shutdown();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
      shutdownGate.resolve();
      await Promise.all([firstShutdown, repeatedShutdown, ...reentrantShutdowns]);

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(reentrantShutdowns.length).toBeGreaterThan(0);
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({
        status: "unavailable",
        error: "Provider runtime has shut down",
      });
    } finally {
      shutdownGate.resolve();
      manager.destroy();
    }
  });

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
  test("settings refresh passes the semantic global scope to providers", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex"] });

      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: true });
    } finally {
      manager.destroy();
    }
  });

  test("global snapshot does not satisfy an explicit home workspace read", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await manager.listProviders({ cwd: homedir(), providers: ["codex"], wait: true });

      expect(fetchCatalog.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ scope: "global", force: true }),
        expect.objectContaining({
          scope: "workspace",
          cwd: resolveSnapshotCwd(homedir()),
          force: false,
        }),
      ]);
    } finally {
      manager.destroy();
    }
  });

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

  test("getSnapshot called with no cwd resolves to the global snapshot key", () => {
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
      expect(cwds).toContain(GLOBAL_PROVIDER_SNAPSHOT_KEY);
    } finally {
      manager.destroy();
    }
  });

  test("resolveSnapshotCwd normalizes pure drive letters to append backslash on Windows", () => {
    const resolved = resolveSnapshotCwd("C:");
    if (process.platform === "win32") {
      expect(resolved).toBe("C:\\");
    } else {
      expect(resolved).toBeDefined();
    }
  });
});
