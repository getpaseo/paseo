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
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
  resolveSnapshotCwd,
} from "./provider-snapshot-manager.js";
import { registerNativeProvider } from "./providers/native/provider.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;
const TEST_REFRESH_TIMEOUT_MS = 120_000;

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

type SnapshotManagerOptions = ConstructorParameters<typeof ProviderSnapshotManager>[0] & {
  nativeClients?: Partial<Record<AgentProvider, AgentClient>>;
};

function createSnapshotManager({
  nativeClients,
  extraRegistrations = [],
  ...options
}: SnapshotManagerOptions): ProviderSnapshotManager {
  const nativeRegistrations = Object.entries(nativeClients ?? {}).flatMap(([id, client]) =>
    client
      ? [
          registerNativeProvider({
            id,
            label: id,
            createClient: () => client,
          }),
        ]
      : [],
  );
  return new ProviderSnapshotManager({
    ...options,
    extraRegistrations: [...extraRegistrations, ...nativeRegistrations],
  });
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

function waitUntilAborted(signal?: AbortSignal): Promise<boolean> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("ProviderSnapshotManager public surface", () => {
  test("validates complete Hub agent configurations through the current provider contract", async () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [
              {
                provider: "codex",
                id: "gpt-5.5",
                aliases: ["gpt-latest"],
                label: "GPT 5.5",
                thinkingOptions: [{ id: "xhigh", label: "Extra high" }],
              },
            ],
            modes: [{ id: "auto-review", label: "Auto review" }],
          }),
        }),
      },
    });

    try {
      await expect(
        manager.validateAgentConfiguration({
          provider: "codex",
          model: "gpt-latest",
          modeId: "auto-review",
          thinkingOptionId: "xhigh",
          providerOptions: {
            sandbox_workspace_write: {
              writable_roots: ["/var/cache/npm"],
              network_access: false,
            },
          },
        }),
      ).resolves.toEqual([]);

      await expect(
        manager.validateAgentConfiguration({
          provider: "codex",
          model: "missing",
          modeId: "missing",
          thinkingOptionId: "missing",
          providerOptions: {
            sandbox_workspace_write: { network_access: "sometimes" },
          },
        }),
      ).resolves.toEqual([
        { path: ["model"], message: "Model 'missing' is not available for provider 'codex'" },
        { path: ["modeId"], message: "Mode 'missing' is not available for provider 'codex'" },
        {
          path: ["thinkingOptionId"],
          message: "Thinking option 'missing' is not available for provider 'codex'",
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("reports an unavailable Hub agent provider at the authored provider field", async () => {
    const manager = createSnapshotManager({ logger: createTestLogger() });
    try {
      await expect(
        manager.validateAgentConfiguration({ provider: "not-installed" }),
      ).resolves.toEqual([
        { path: ["provider"], message: "Provider 'not-installed' is not configured" },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("listRegisteredProviderIds includes the built-in providers", () => {
    const manager = createSnapshotManager({ logger: createTestLogger() });
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({ logger: createTestLogger() });
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
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

  test("a native registration whose client is unavailable reports its connection error", async () => {
    const isAvailable = vi.fn().mockResolvedValue(false);
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: { codex: createExtraClient("codex", { isAvailable }) },
    });
    try {
      const entry = await manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(entry.provider).toBe("codex");
      expect(entry.status).toBe("error");
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
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

      expect(isAvailableCodex).toHaveBeenCalledTimes(1);
      expect(fetchCodexCatalog).toHaveBeenCalledTimes(2);
      expect(isAvailableClaude).toHaveBeenCalledTimes(1);
      expect(fetchClaudeCatalog).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("refreshTimeoutMs option overrides the default and yields a timeout error", async () => {
    // never-resolving isAvailable forces the timeout path
    const isAvailable = vi.fn(waitUntilAborted);
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 1,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: { codex: createExtraClient("codex", { isAvailable }) },
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

  test("setRefreshTimeoutMs changes the deadline for future refreshes", async () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 60_000,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
        codex: createExtraClient("codex", { isAvailable: vi.fn(waitUntilAborted) }),
      },
    });
    manager.setRefreshTimeoutMs(1);

    try {
      await expect(
        manager.getProvider({ cwd: "/tmp/project", provider: "codex", wait: true }),
      ).resolves.toMatchObject({
        status: "error",
        error: "Timed out refreshing Codex after 1ms; pending: availability",
      });
    } finally {
      manager.destroy();
    }
  });

  test("defaults provider refreshes to a two-minute deadline", async () => {
    vi.useFakeTimers();
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
        codex: createExtraClient("codex", { isAvailable: waitUntilAborted }),
      },
    });

    try {
      const entryPromise = manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });

      await vi.advanceTimersByTimeAsync(120_000);

      await expect(entryPromise).resolves.toMatchObject({
        status: "error",
        error: "Timed out refreshing Codex after 120000ms; pending: availability",
      });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("one refresh timeout covers availability and catalog discovery", async () => {
    vi.useFakeTimers();
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: () =>
            new Promise((settle) => {
              setTimeout(() => settle(true), 60);
            }),
          fetchCatalog: () =>
            new Promise((settle) => {
              setTimeout(() => settle({ models: [], modes: [] }), 60);
            }),
        }),
      },
    });

    try {
      const entryPromise = manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });

      await vi.advanceTimersByTimeAsync(120);

      await expect(entryPromise).resolves.toMatchObject({
        provider: "codex",
        status: "error",
        error: "Timed out refreshing Codex after 100ms",
      });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("a timed-out catalog request does not block a later refresh", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetchCatalog = vi.fn(async () => {
      attempt += 1;
      if (attempt > 1) return { models: [], modes: [] };
      return new Promise<never>(() => undefined);
    });
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog,
        }),
      },
    });

    try {
      const first = manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({
        status: "error",
        error: "Timed out refreshing Codex after 100ms",
      });

      await manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(
        manager.getSnapshot("/tmp/project").find((entry) => entry.provider === "codex"),
      ).toMatchObject({ provider: "codex", status: "ready" });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("each provider refresh gets its own timeout", async () => {
    vi.useFakeTimers();
    const neverReturnsCatalog = (_options: FetchCatalogOptions) =>
      new Promise<never>(() => undefined);
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: neverReturnsCatalog,
        }),
        claude: createExtraClient("claude", {
          isAvailable: async () => true,
          fetchCatalog: neverReturnsCatalog,
        }),
      },
    });

    try {
      const codexPromise = manager.getProvider({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      await vi.advanceTimersByTimeAsync(50);

      const claudePromise = manager.getProvider({
        cwd: "/tmp/project",
        provider: "claude",
        wait: true,
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(codexPromise).resolves.toMatchObject({
        provider: "codex",
        status: "error",
      });
      await expect(
        manager.getProvider({ cwd: "/tmp/project", provider: "claude", wait: false }),
      ).resolves.toMatchObject({ provider: "claude", status: "loading" });

      await vi.advanceTimersByTimeAsync(50);

      await expect(claudePromise).resolves.toMatchObject({
        provider: "claude",
        status: "error",
      });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("PASEO_PROVIDER_REFRESH_TIMEOUT_MS env var is honored when no option is given", async () => {
    vi.stubEnv("PASEO_PROVIDER_REFRESH_TIMEOUT_MS", "1");
    const isAvailable = vi.fn(waitUntilAborted);
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: { codex: createExtraClient("codex", { isAvailable }) },
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
    const isAvailable = vi.fn(waitUntilAborted);
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 5,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: { codex: createExtraClient("codex", { isAvailable }) },
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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

  test("listModels excludes compatibility-only catalog entries", async () => {
    const client = createExtraClient("codex", {
      isAvailable: async () => true,
      fetchCatalog: async () => ({
        models: [
          { provider: "codex", id: "gpt-5.4", label: "GPT 5.4" },
          {
            provider: "codex",
            id: "gpt-5.4-legacy",
            label: "GPT 5.4 legacy",
            isSelectable: false,
          },
        ],
        modes: [],
      }),
    });
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: { codex: client },
    });
    try {
      const models = await manager.listModels({
        cwd: "/tmp/project",
        provider: "codex",
        wait: true,
      });
      expect(models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    } finally {
      manager.destroy();
    }
  });

  test("listModes rejects when the provider is disabled", async () => {
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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

  test("getProviderDiagnostic uses generic availability without invoking a provider hook", async () => {
    const getDiagnostic = vi.fn(async () => ({ diagnostic: "codex is ready" }));
    const client = createExtraClient("codex", { getDiagnostic });
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).not.toContain("codex is ready");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
      expect(getDiagnostic).not.toHaveBeenCalled();
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: { codex: client },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: false });
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic reports generic snapshot models/status", async () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: { codex: createExtraClient("codex") },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.provider).toBe("codex");
      expect(result.diagnostic).toContain("Models:");
      expect(result.diagnostic).toContain("Status:");
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic materializes the client and proceeds for an unmaterialized configured provider", async () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      isDev: true,
      nativeClients: {},
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

  test("getProviderDiagnostic ignores provider-specific diagnostic hooks", async () => {
    const getDiagnostic = vi.fn(async () => {
      throw new Error("diagnostic probe exploded");
    });
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: async () => true,
          fetchCatalog: async () => ({
            models: [{ provider: "codex", id: "gpt-5.4-mini", label: "GPT 5.4 Mini" }],
            modes: [] as AgentMode[],
          }),
          getDiagnostic,
        }),
      },
    });
    try {
      const result = await manager.getProviderDiagnostic("codex");
      expect(result.diagnostic).not.toContain("diagnostic probe exploded");
      expect(result.diagnostic).toContain("Models: 1");
      expect(result.diagnostic).toContain("Status: Ready");
      expect(getDiagnostic).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("getProviderDiagnostic reports a stuck catalog refresh inside the diagnostic", async () => {
    await withEnv("PASEO_ENABLE_MOCK_SLOW", "true", async () => {
      vi.useFakeTimers();
      const manager = createSnapshotManager({
        logger: createTestLogger(),
        isDev: true,
        refreshTimeoutMs: TEST_REFRESH_TIMEOUT_MS,
      });
      try {
        const diagnosticRequest = manager.getProviderDiagnostic("mock-slow");
        await vi.advanceTimersByTimeAsync(TEST_REFRESH_TIMEOUT_MS);

        const result = await diagnosticRequest;
        expect(result.provider).toBe("mock-slow");
        expect(result.diagnostic).toContain("Mock Slow Provider");
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
    const manager = createSnapshotManager({ logger: createTestLogger() });
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

  test("getAgentManagerProviderState exposes provider runtimes for native registrations", () => {
    const codexClient = createExtraClient("codex");
    const claudeClient = createExtraClient("claude");
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { opencode: { enabled: false }, copilot: { enabled: false } },
      nativeClients: { codex: codexClient, claude: claudeClient },
    });
    try {
      const state = manager.getAgentManagerProviderState();
      expect(state.providers.codex?.id).toBe("codex");
      expect(state.providers.claude?.id).toBe("claude");
      expect(state.providerDefinitions.opencode).toMatchObject({ enabled: false });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: true });
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig uses negotiated modes without provider policy hooks", async () => {
    const resolveCreateConfig = vi.fn(async () => ({
      modeId: "provider-hook-mode",
      featureValues: undefined,
    }));
    const isCreateConfigUnattended = vi.fn(() => false);
    const childModes: AgentMode[] = [
      { id: "child-unattended", label: "Child", isUnattended: true },
    ];
    const parentModes: AgentMode[] = [
      { id: "parent-unattended", label: "Parent", isUnattended: true },
    ];
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: childModes };
          },
          resolveCreateConfig,
        }),
        claude: createExtraClient("claude", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes: parentModes };
          },
          isCreateConfigUnattended,
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
      expect(resolveCreateConfig).not.toHaveBeenCalled();
      expect(isCreateConfigUnattended).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("resolveCreateConfig uses generic unattended mode selection", async () => {
    const resolveCreateConfig = vi.fn(async () => ({
      modeId: "provider-hook-mode",
      featureValues: undefined,
    }));
    const modes: AgentMode[] = [{ id: "worker", label: "Worker", isUnattended: true }];
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
          },
          resolveCreateConfig,
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

      expect(resolved).toEqual({ modeId: "worker", featureValues: { fast_mode: true } });
      expect(resolveCreateConfig).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("does not derive creation features from provider-specific parent config", async () => {
    const modes: AgentMode[] = [
      { id: "build", label: "Build" },
      { id: "base", label: "Base" },
      { id: "orchestrator", label: "Orchestrator" },
    ];
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        pi: { enabled: false },
      },
      nativeClients: {
        opencode: createExtraClient("opencode", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            return { models: [] as AgentModelDefinition[], modes };
          },
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

      expect(resolved).toEqual({ modeId: "base", featureValues: undefined });
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager applyMutableProviderConfig", () => {
  test("adds a derived provider and includes it in subsequent reads", async () => {
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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

  test("drops disabled built-in provider runtimes while preserving providerDefinitions", () => {
    const manager = createSnapshotManager({
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
      expect(before.providers.copilot).toBeUndefined();

      const state = manager.applyMutableProviderConfig({ codex: { enabled: false } });
      expect(state.providerDefinitions.codex).toMatchObject({ enabled: false });
      expect(state.providers.codex).toBeUndefined();
      expect(state.providerDefinitions.copilot).toMatchObject({ enabled: false });
      expect(state.providers.copilot).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("fires a change event on every primed snapshot cwd after applyMutableProviderConfig", () => {
    const manager = createSnapshotManager({
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

  test("stages provider state without events, then publishes or rolls back", () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: true },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    try {
      const cwd = resolve("/tmp/project");
      manager.getSnapshot(cwd);
      const events: string[] = [];
      manager.on("change", (_entries, changedCwd) => events.push(changedCwd));

      const rolledBack = manager.stageMutableProviderConfig(
        { codex: { enabled: false } },
        { replace: true },
      );
      expect(events).toEqual([]);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: false,
      });
      rolledBack.rollback();
      expect(events).toEqual([]);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: true,
      });

      const committed = manager.stageMutableProviderConfig(
        { codex: { enabled: false } },
        { replace: true },
      );
      expect(events).toEqual([]);
      committed.publish();
      expect(events).toEqual([cwd]);
    } finally {
      manager.destroy();
    }
  });

  test("restores provider state when applying a live config fails", () => {
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        claude: { enabled: false },
        codex: { enabled: true },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    });
    manager.getSnapshot("/tmp/project");
    manager.on("change", () => {
      throw new Error("snapshot consumer failed");
    });

    try {
      expect(() =>
        manager.applyMutableProviderConfig({ codex: { enabled: false } }, { replace: true }),
      ).toThrow("snapshot consumer failed");
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: true,
      });
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager lifecycle", () => {
  test("owns every materialized provider runtime generation until daemon shutdown", async () => {
    const providerConfig = (label: string) => ({
      claude: { enabled: false },
      codex: { enabled: true, label },
      copilot: { enabled: false },
      omp: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
    });
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: providerConfig("Initial"),
    });
    const shutdowns: Array<ReturnType<typeof vi.fn>> = [];
    const trackClose = <Runtime extends { close(): Promise<void> } | undefined>(
      runtime: Runtime,
    ): Exclude<Runtime, undefined> => {
      if (!runtime) throw new Error("Expected materialized Codex provider runtime");
      const close = vi.fn(async () => undefined);
      runtime.close = close;
      shutdowns.push(close);
      return runtime as Exclude<Runtime, undefined>;
    };

    const initialRuntime = trackClose(manager.getAgentManagerProviderState().providers.codex);
    const published = manager.stageMutableProviderConfig(providerConfig("Published"), {
      replace: true,
    });
    const publishedRuntime = trackClose(published.agentManagerState.providers.codex);
    published.publish();

    const rolledBack = manager.stageMutableProviderConfig(providerConfig("Rolled back"), {
      replace: true,
    });
    trackClose(rolledBack.agentManagerState.providers.codex);
    rolledBack.rollback();

    expect(manager.getAgentManagerProviderState().providers.codex).toBe(publishedRuntime);

    const newest = manager.stageMutableProviderConfig(providerConfig("Newest"), { replace: true });
    const newestRuntime = trackClose(newest.agentManagerState.providers.codex);
    newest.publish();

    expect(initialRuntime).not.toBe(publishedRuntime);
    expect(manager.getAgentManagerProviderState().providers.codex).toBe(newestRuntime);
    for (const shutdown of shutdowns) expect(shutdown).not.toHaveBeenCalled();

    await manager.shutdown();

    for (const shutdown of shutdowns) expect(shutdown).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  test("on/off attaches and detaches change listeners", () => {
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
        codex: createExtraClient("codex", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex"] });

      expect(fetchCatalog.mock.calls[0]?.[0]).toMatchObject({ scope: "global", force: false });
    } finally {
      manager.destroy();
    }
  });

  test("global snapshot does not satisfy an explicit home workspace read", async () => {
    const fetchCatalog = vi.fn(async () => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = createSnapshotManager({
      logger: createTestLogger(),
      nativeClients: {
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
        expect.objectContaining({ scope: "global", force: false }),
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
    const manager = createSnapshotManager({
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
    const manager = createSnapshotManager({
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
