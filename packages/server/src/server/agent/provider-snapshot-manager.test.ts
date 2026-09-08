import pino from "pino";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  FetchCatalogOptions,
  ProviderRefreshContext,
  ResolveAgentCreateConfigInput,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
  type ProviderSnapshot,
  resolveSnapshotCwd,
} from "./provider-snapshot-manager.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;
const CLOSED_PARENT: ManagedAgent = {
  id: "parent-agent",
  provider: "codex",
  cwd: "/tmp/project",
  capabilities: TEST_CAPABILITIES,
  config: { provider: "codex", cwd: "/tmp/project" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  availableModes: [],
  currentModeId: null,
  pendingPermissions: new Map(),
  bufferedPermissionResolutions: new Map(),
  inFlightPermissionResponses: new Set(),
  pendingReplacement: false,
  persistence: null,
  historyPrimed: false,
  lastUserMessageAt: null,
  activeTurnId: null,
  activeTurnStartedAt: null,
  attention: { requiresAttention: false },
  foregroundTurnWaiters: new Set(),
  finalizedForegroundTurnIds: new Set(),
  unsubscribeSession: null,
  labels: {},
  lifecycle: "closed",
  session: null,
  activeForegroundTurnId: null,
};
const TEST_REFRESH_TIMEOUT_MS = 120_000;

// Builds an AgentClient that can be injected via the public extraClients option.
// extraClients is the only injection surface the manager exposes for tests.
function createExtraClient(
  provider: AgentProvider,
  overrides: Partial<AgentClient> = {},
): AgentClient {
  return {
    provider,
    capabilities: TEST_CAPABILITIES,
    getCatalogCacheKey:
      provider === "codex" || provider === "claude" ? async () => "host" : undefined,
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

function waitUntilAborted(signal?: AbortSignal): Promise<boolean> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((finish) => setTimeout(finish, delayMs));
}

function waitForAbortWithCleanup(
  signal: AbortSignal,
  cleanupState: { cleanedUp: boolean },
): Promise<void> {
  return new Promise((_resolve, reject) => {
    const handleAbort = () => {
      cleanupState.cleanedUp = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function runTestCatalogActivities(
  context: ProviderRefreshContext,
  cleanupState: { cleanedUp: boolean },
): Promise<void> {
  const waitForAgents = () => waitForDelay(50);
  const waitForProviders = () => waitForAbortWithCleanup(context.signal, cleanupState);
  await Promise.all([
    context.runActivity("app.agents", waitForAgents),
    context.runActivity("provider.list", waitForProviders),
  ]);
}

describe("ProviderSnapshotManager public surface", () => {
  test("carries a plugin provider icon in snapshot metadata", () => {
    const iconSvg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    const registration: ProviderRegistration = {
      id: "icon-provider",
      label: "Icon Provider",
      icon: iconSvg,
      async connect() {
        throw new Error("not opened by this test");
      },
    };
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });

    try {
      manager.replacePluginProviders([registration]);

      expect(manager.getSnapshot("/tmp/project").records.map(({ entry }) => entry)).toContainEqual(
        expect.objectContaining({ provider: "icon-provider", iconSvg }),
      );
    } finally {
      manager.destroy();
    }
  });

  test("validates complete Hub agent configurations through the current provider contract", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
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
        {
          path: ["providerOptions", "sandbox_workspace_write", "network_access"],
          message: "Invalid input: expected boolean, received string",
        },
      ]);
    } finally {
      manager.destroy();
    }
  });

  test("reports an unavailable Hub agent provider at the authored provider field", async () => {
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
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
      const snapshot = manager.getSnapshot("/tmp/project").records.map(({ entry }) => entry);
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
    const isAvailable = vi.fn(waitUntilAborted);
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

  test("setRefreshTimeoutMs changes the deadline for future refreshes", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 60_000,
      providerOverrides: {
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
      extraClients: {
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
    let recovered = false;
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
          isAvailable: (signal) => (recovered ? Promise.resolve(true) : waitUntilAborted(signal)),
        }),
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
      recovered = true;
      await manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      const ready = manager.getSnapshot("/tmp/project");
      const transitions: unknown[] = [];
      manager.on("change", (transition) => transitions.push(transition));
      await manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      expect(manager.getSnapshot("/tmp/project")).toBe(ready);
      expect(transitions).toEqual([]);
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("one refresh timeout covers availability and catalog discovery", async () => {
    vi.useFakeTimers();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      extraClients: {
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

  test("timeout names pending catalog activities, aborts them, and waits for cleanup", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const cleanupState = { cleanedUp: false };
    const fetchCatalog = vi.fn(
      async (_options: FetchCatalogOptions, context?: ProviderRefreshContext) => {
        attempt += 1;
        if (attempt > 1) {
          expect(cleanupState.cleanedUp).toBe(true);
          return { models: [], modes: [] };
        }

        if (!context) throw new Error("missing refresh context");
        await runTestCatalogActivities(context, cleanupState);
        return { models: [], modes: [] };
      },
    );
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      extraClients: {
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
        error: "Timed out refreshing Codex after 100ms; pending: provider.list",
      });
      expect(cleanupState.cleanedUp).toBe(true);

      await manager.refreshSnapshotForCwd({ cwd: "/tmp/project", providers: ["codex"] });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(
        manager.getSnapshot("/tmp/project").records.find(({ entry }) => entry.provider === "codex")
          ?.entry,
      ).toMatchObject({ provider: "codex", status: "ready" });
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("each provider refresh gets its own timeout", async () => {
    vi.useFakeTimers();
    const neverReturnsCatalog = (_options: FetchCatalogOptions, context?: ProviderRefreshContext) =>
      new Promise<never>((_resolve, reject) => {
        context?.signal.addEventListener("abort", () => reject(context.signal.reason), {
          once: true,
        });
      });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      refreshTimeoutMs: 100,
      extraClients: {
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
    const isAvailable = vi.fn(waitUntilAborted);
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
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: client },
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
    const fetchCatalog = vi.fn(async (_options: FetchCatalogOptions) => ({
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
          fetchCatalog: async (_options, context) => {
            await context?.runActivity("model/list", () => waitUntilAborted(context.signal));
            return { models: [], modes: [] };
          },
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
          fetchCatalog: async (_options, context) => {
            snapshotStarted = true;
            await context?.runActivity("model/list", () => waitUntilAborted(context.signal));
            return { models: [], modes: [] };
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
          resolveCreateConfig(input) {
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
      const parent: ManagedAgent = {
        ...CLOSED_PARENT,
        id: "parent-agent",
        provider: "claude",
        currentModeId: "parent-unattended",
        availableModes: parentModes,
        config: { provider: "claude", cwd: "/tmp/project" },
      };

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
          resolveCreateConfig(input) {
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
      const parent: ManagedAgent = {
        ...CLOSED_PARENT,
        id: "parent-agent",
        provider: "opencode",
        currentModeId: "orchestrator",
        availableModes: modes,
        config: {
          provider: "opencode",
          cwd: "/tmp/project",
          featureValues: { auto_accept: true },
        },
      };

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
      expect(
        manager
          .getSnapshot()
          .records.map(({ entry }) => entry)
          .find((entry) => entry.provider === "zai-claude")?.source,
      ).toBe("custom");
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
      expect(
        manager
          .getSnapshot()
          .records.map(({ entry }) => entry)
          .some((entry) => entry.provider === "zai-claude"),
      ).toBe(false);

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

      const cwds = [...new Set(listener.mock.calls.map((call) => call[0].current.cwd))].sort();
      expect(cwds).toEqual([cwdA, cwdB].sort());
    } finally {
      manager.destroy();
    }
  });

  test("changing one provider preserves other catalogs and clients across directories", async () => {
    const calls = { claude: 0, codex: 0 };
    const clients = Object.fromEntries(
      (["claude", "codex"] as const).map((provider) => [
        provider,
        createExtraClient(provider, {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            calls[provider]++;
            return { models: [], modes: [] };
          },
        }),
      ]),
    );
    const config = {
      claude: { enabled: true },
      codex: { enabled: true, command: ["codex"], env: { TEST_SETTING: "same" } },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      omp: { enabled: false },
    };
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: config,
      runtimeSettings: {
        codex: { command: { mode: "replace", argv: ["codex"] }, env: { TEST_SETTING: "same" } },
      },
      extraClients: clients,
    });
    const cwds = [resolve("/tmp/catalog-a"), resolve("/tmp/catalog-b")];
    try {
      for (const cwd of cwds) await manager.warmUpSnapshotForCwd({ cwd });
      const getCodexEntry = (cwd: string) =>
        manager.getSnapshot(cwd).records.find(({ entry }) => entry.provider === "codex")?.entry;
      const before = cwds.map(getCodexEntry);
      const definition = manager.getAgentManagerProviderState().providerDefinitions.codex;
      manager.applyMutableProviderConfig(
        { ...config, claude: { enabled: true, label: "Renamed" } },
        { replace: true },
      );
      expect(cwds.map(getCodexEntry)).toEqual(before);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toEqual(definition);
      for (const cwd of cwds) await manager.warmUpSnapshotForCwd({ cwd });
      expect(calls).toEqual({ claude: 2, codex: 1 });
      const listener = vi.fn();
      manager.on("change", listener);
      manager.applyMutableProviderConfig(
        { ...config, claude: { label: "Renamed", enabled: true } },
        { replace: true },
      );
      for (const cwd of cwds) await manager.warmUpSnapshotForCwd({ cwd });
      expect(calls).toEqual({ claude: 2, codex: 1 });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("reload preserves an unchanged lookup in flight through commit and discarded preparation", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((complete) => {
      finish = complete;
    });
    let calls = 0;
    const config = {
      claude: { enabled: false },
      codex: { enabled: true },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      omp: { enabled: false },
    };
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: config,
      extraClients: {
        codex: createExtraClient("codex", {
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            calls++;
            await gate;
            return { models: [], modes: [] };
          },
        }),
      },
    });
    const cwd = resolve("/tmp/catalog-pending");
    try {
      const pending = manager.warmUpSnapshotForCwd({ cwd });
      await vi.waitFor(() => expect(calls).toBe(1));
      manager.applyMutableProviderConfig(
        { ...config, claude: { enabled: false, label: "Changed" } },
        { replace: true },
      );
      const staged = manager.prepareMutableProviderConfig(
        { ...config, claude: { enabled: false, label: "Rollback" } },
        { replace: true },
      );
      expect(staged.agentManagerState.providerDefinitions.claude?.enabled).toBe(false);
      finish();
      await pending;
      expect(
        manager
          .getSnapshot(cwd)
          .records.map(({ entry }) => entry)
          .find((e) => e.provider === "codex")?.status,
      ).toBe("ready");
      expect(calls).toBe(1);
    } finally {
      finish();
      manager.destroy();
    }
  });

  test("reload replaces derived clients only when their provider configuration changes", async () => {
    const config = {
      claude: { enabled: true },
      codex: { enabled: true },
      "codex-2": { extends: "codex", label: "Codex 2", enabled: true },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      omp: { enabled: false },
    };
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: config,
    });
    try {
      const before = manager.getAgentManagerProviderState().clients;
      for (const provider of ["codex", "claude", "codex-2"]) {
        expect(
          await before[provider]!.getCatalogCacheKey?.({ scope: "global", force: false }),
        ).toBe("host");
        expect(
          await before[provider]!.getCatalogCacheKey?.({
            scope: "workspace",
            cwd: resolveSnapshotCwd("/project"),
            force: true,
          }),
        ).toBe("host");
      }
      const unchanged = manager.applyMutableProviderConfig(config, { replace: true }).clients;
      expect(unchanged.codex).toBe(before.codex);
      expect(unchanged["codex-2"]).toBe(before["codex-2"]);
      const changed = manager.applyMutableProviderConfig(
        { ...config, codex: { enabled: true, env: { CODEX_HOME: "/tmp/other-codex-home" } } },
        { replace: true },
      ).clients;
      expect(changed.claude).toBe(before.claude);
      expect(changed.codex).not.toBe(before.codex);
      expect(changed["codex-2"]).not.toBe(before["codex-2"]);
      const { "codex-2": _removedProvider, ...withoutDerived } = config;
      const removed = manager.applyMutableProviderConfig(withoutDerived, { replace: true }).clients;
      expect(removed["codex-2"]).toBeUndefined();
      expect(removed.claude).toBe(before.claude);
    } finally {
      manager.destroy();
    }
  });

  test("preparation leaves installed reads untouched and commit installs all target memberships before notification", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: PUBLICATION_PROVIDERS,
      extraClients: { codex: createExtraClient("codex") },
    });
    try {
      const cwds = ["/tmp/install-a", "/tmp/install-b"];
      const previous = cwds.map((cwd) => manager.getSnapshot(cwd));
      const observations: Array<{ current: ProviderSnapshot; reads: ProviderSnapshot[] }> = [];
      manager.on("change", ({ current }) =>
        observations.push({
          current,
          reads: [manager.getSnapshot(cwds[0]), manager.getSnapshot(cwds[1])],
        }),
      );
      const config = {
        ...PUBLICATION_PROVIDERS,
        codex: { enabled: false },
        claude: { enabled: false, label: "Changed" },
        custom: { extends: "codex", label: "Custom", enabled: false },
      };
      const prepared = manager.prepareMutableProviderConfig(config, { replace: true });
      expect(prepared.agentManagerState.providerDefinitions.custom?.enabled).toBe(false);
      expect(manager.hasProvider("custom")).toBe(false);
      expect(manager.listRegisteredProviderIds()).not.toContain("custom");
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex?.enabled).toBe(true);
      expect(cwds.map((cwd) => manager.getSnapshot(cwd))).toEqual(previous);
      expect(manager.getSnapshot(cwds[0])).toBe(previous[0]);
      expect(observations).toEqual([]);
      expect(() =>
        manager.prepareMutableProviderConfig(
          { custom: { extends: "missing-provider" } },
          { replace: true },
        ),
      ).toThrow();
      expect(manager.getSnapshot(cwds[0])).toBe(previous[0]);
      prepared.commit();
      const committed = cwds.map((cwd) => manager.getSnapshot(cwd));
      expect(observations).toHaveLength(2);
      for (const [index, observation] of observations.entries()) {
        expect(observation.current).toBe(committed[index]);
        expect(observation.reads[0]).toBe(committed[0]);
        expect(observation.reads[1]).toBe(committed[1]);
      }
      expect(manager.hasProvider("custom")).toBe(true);
      expect(
        committed[0]!.records.map(({ entry }) => [entry.provider, entry.status, entry.label]),
      ).toContainEqual(["codex", "unavailable", "Codex"]);
      expect(manager.getProviderLabel("claude")).toBe("Changed");
    } finally {
      manager.destroy();
    }
  });

  test("subscriber failures cannot change discovery results, roll back commits or starve another listener", async () => {
    const logs: string[] = [];
    const logger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const manager = new ProviderSnapshotManager({
      logger,
      providerOverrides: PUBLICATION_PROVIDERS,
      extraClients: { codex: createExtraClient("codex", { isAvailable: async () => true }) },
    });
    const transitions: ProviderSnapshot[] = [];
    manager.on("change", () => {
      throw new Error("subscriber failed");
    });
    manager.on("change", ({ current }) => transitions.push(current));
    try {
      await manager.warmUpSnapshotForCwd({ cwd: "/tmp/subscribers" });
      expect(
        manager
          .getSnapshot("/tmp/subscribers")
          .records.find(({ entry }) => entry.provider === "codex")!.entry.status,
      ).toBe("ready");
      manager.applyMutableProviderConfig(
        { ...PUBLICATION_PROVIDERS, codex: { enabled: false } },
        { replace: true },
      );
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex?.enabled).toBe(false);
      const statuses = [];
      for (const { records } of transitions) {
        statuses.push(records.find(({ entry }) => entry.provider === "codex")!.entry.status);
      }
      expect(statuses).toEqual(["ready", "unavailable"]);
      expect(logs.map((line) => JSON.parse(line))).toMatchObject([
        { msg: "Provider snapshot subscriber failed", err: { message: "subscriber failed" } },
        { msg: "Provider snapshot subscriber failed", err: { message: "subscriber failed" } },
      ]);
    } finally {
      manager.destroy();
    }
  });
});

describe("ProviderSnapshotManager lifecycle", () => {
  test("owns every materialized client generation until daemon shutdown", async () => {
    const providerConfig = (label: string) => ({
      claude: { enabled: false },
      codex: { enabled: true, label },
      copilot: { enabled: false },
      omp: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: providerConfig("Initial"),
    });
    const shutdowns: Array<ReturnType<typeof vi.fn>> = [];
    const trackShutdown = (client: AgentClient | undefined): AgentClient => {
      if (!client) throw new Error("Expected materialized Codex client");
      const shutdown = vi.fn(async () => undefined);
      client.shutdown = shutdown;
      shutdowns.push(shutdown);
      return client;
    };

    const initialClient = trackShutdown(manager.getAgentManagerProviderState().clients.codex);
    const published = manager.prepareMutableProviderConfig(providerConfig("Published"), {
      replace: true,
    });
    const publishedClient = trackShutdown(published.agentManagerState.clients.codex);
    published.commit();

    const rolledBack = manager.prepareMutableProviderConfig(providerConfig("Rolled back"), {
      replace: true,
    });
    trackShutdown(rolledBack.agentManagerState.clients.codex);

    expect(manager.getAgentManagerProviderState().clients.codex).toBe(publishedClient);

    const newest = manager.prepareMutableProviderConfig(providerConfig("Newest"), {
      replace: true,
    });
    const newestClient = trackShutdown(newest.agentManagerState.clients.codex);
    newest.commit();

    expect(initialClient).not.toBe(publishedClient);
    expect(manager.getAgentManagerProviderState().clients.codex).toBe(newestClient);
    for (const shutdown of shutdowns) expect(shutdown).not.toHaveBeenCalled();

    await manager.shutdown();

    for (const shutdown of shutdowns) expect(shutdown).toHaveBeenCalledTimes(1);
    manager.destroy();
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
      manager.applyMutableProviderConfig({ claude: { enabled: false, label: "Changed" } });
      const firstCallCount = listener.mock.calls.length;
      expect(firstCallCount).toBe(1);

      manager.off("change", listener);
      manager.applyMutableProviderConfig({ claude: { enabled: false, label: "Changed again" } });
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
  test("deduplicates cold global catalogue discovery across concurrent workspace reads", async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const discoveryStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const requests: FetchCatalogOptions[] = [];
    let availabilityProbes = 0;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        codex: createExtraClient("codex", {
          async getCatalogCacheKey() {
            return "host";
          },
          async isAvailable() {
            availabilityProbes++;
            return true;
          },
          async fetchCatalog(options) {
            requests.push(options);
            started();
            await pending;
            return {
              models: [{ provider: "codex", id: "gpt-6-astra", label: "GPT-6 Astra" }],
              modes: [],
            };
          },
        }),
      },
    });
    try {
      const reads = Promise.all(
        [
          undefined,
          resolveSnapshotCwd("/tmp/concurrent-a"),
          resolveSnapshotCwd("/tmp/concurrent-b"),
        ].map((cwd) => manager.getProvider({ provider: "codex", cwd, wait: true })),
      );
      await discoveryStarted;
      expect(requests).toEqual([{ scope: "global", force: false }]);
      release();
      const entries = await reads;
      expect(entries.map((entry) => entry.models?.[0]?.id)).toEqual([
        "gpt-6-astra",
        "gpt-6-astra",
        "gpt-6-astra",
      ]);
      expect(requests).toHaveLength(1);
      expect(availabilityProbes).toBe(1);
    } finally {
      release();
      await manager.shutdown();
      manager.destroy();
    }
  });

  test.each(["codex", "custom-codex"])(
    "shares %s discovery and refresh recovery across snapshot directories",
    async (provider) => {
      const requests: FetchCatalogOptions[] = [];
      let available = false;
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        providerOverrides: {
          "custom-codex": { extends: "codex", label: "Custom Codex", enabled: true },
        },
        extraClients: {
          [provider]: createExtraClient(provider, {
            async getCatalogCacheKey() {
              return "host";
            },
            async isAvailable() {
              return available;
            },
            async fetchCatalog(options) {
              requests.push(options);
              return {
                models: [{ provider, id: "gpt-6-astra", label: "GPT-6 Astra" }],
                modes: [],
              };
            },
          }),
        },
      });
      try {
        expect(await manager.getProvider({ provider, wait: true })).toMatchObject({
          status: "unavailable",
        });
        available = true;
        await manager.refreshSnapshotForCwd({
          cwd: resolveSnapshotCwd("/tmp/model-memory-a"),
          providers: [provider],
        });
        expect(await manager.getProvider({ provider, wait: true })).toMatchObject({
          status: "ready",
        });
        await Promise.all([
          manager.getProvider({
            provider,
            cwd: resolveSnapshotCwd("/tmp/model-memory-a"),
            wait: true,
          }),
          manager.getProvider({
            provider,
            cwd: resolveSnapshotCwd("/tmp/model-memory-b"),
            wait: true,
          }),
        ]);
        expect(requests).toEqual([
          { scope: "workspace", cwd: resolveSnapshotCwd("/tmp/model-memory-a"), force: true },
        ]);
      } finally {
        await manager.shutdown();
        manager.destroy();
      }
    },
  );

  test("settings refresh passes the semantic global scope to providers", async () => {
    const fetchCatalog = vi.fn(async (_options: FetchCatalogOptions) => ({
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
    const fetchCatalog = vi.fn(async (_options: FetchCatalogOptions) => ({
      models: [] as AgentModelDefinition[],
      modes: [] as AgentMode[],
    }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        pi: createExtraClient("pi", {
          isAvailable: vi.fn(async () => true),
          fetchCatalog,
        }),
      },
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["pi"] });
      await manager.listProviders({ cwd: homedir(), providers: ["pi"], wait: true });

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
      const a = manager
        .getSnapshot(resolveSnapshotCwd("/tmp/project-a"))
        .records.map(({ entry }) => entry);
      const b = manager
        .getSnapshot(resolveSnapshotCwd("/tmp/project-b"))
        .records.map(({ entry }) => entry);
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
      manager.applyMutableProviderConfig({ claude: { enabled: false, label: "Changed" } });
      const cwds = listener.mock.calls.map((call) => call[0].current.cwd);
      expect(cwds).toContain(GLOBAL_PROVIDER_SNAPSHOT_KEY);
    } finally {
      manager.destroy();
    }
  });

  test.each([
    { sharing: "shared", expectedCwds: [resolveSnapshotCwd("/tmp/plugin-a")] },
    {
      sharing: "distinct",
      expectedCwds: [
        undefined,
        resolveSnapshotCwd("/tmp/plugin-a"),
        resolveSnapshotCwd("/tmp/plugin-b"),
      ],
    },
    {
      sharing: "absent",
      expectedCwds: [
        undefined,
        resolveSnapshotCwd("/tmp/plugin-a"),
        resolveSnapshotCwd("/tmp/plugin-b"),
      ],
    },
  ])(
    "uses the plugin's provider-owned catalogue key: $sharing",
    async ({ sharing, expectedCwds }) => {
      let listener: ((event: ProviderEvent) => void) | null = null;
      const cwds: Array<string | undefined> = [];
      const registration: ProviderRegistration = {
        id: "scoped-plugin",
        label: "Scoped plugin",
        getCatalogCacheKey:
          sharing === "absent"
            ? undefined
            : async (options) =>
                sharing === "shared"
                  ? "host"
                  : JSON.stringify(options.scope === "workspace" ? options.cwd : null),
        async connect() {
          return {
            version: 1,
            capabilities: [],
            async send(input) {
              if (input.type !== "catalog") return;
              cwds.push(input.cwd);
              listener?.({
                type: "catalog",
                requestId: input.requestId,
                catalog: {
                  models: [{ id: input.cwd ?? "global-model", label: "Model" }],
                  modes: [],
                },
              });
            },
            onEvent(next) {
              listener = next;
              return () => {
                listener = null;
              };
            },
            async close() {},
          };
        },
      };
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        providerOverrides: {
          codex: { enabled: false },
          claude: { enabled: false },
          copilot: { enabled: false },
          opencode: { enabled: false },
          pi: { enabled: false },
        },
      });
      try {
        // Register after workspace views exist, as happens when reloading a plugin.
        for (const cwd of [
          resolveSnapshotCwd("/tmp/plugin-a"),
          resolveSnapshotCwd("/tmp/plugin-b"),
          undefined,
        ]) {
          await manager.listProviders({ cwd, wait: true });
        }
        const published: ProviderSnapshot[] = [];
        manager.on("change", ({ current }) => published.push(current));
        manager.replacePluginProviders([registration]);
        for (const cwd of [
          undefined,
          resolveSnapshotCwd("/tmp/plugin-a"),
          resolveSnapshotCwd("/tmp/plugin-b"),
        ]) {
          const entry = await manager.getProvider({ provider: registration.id, cwd, wait: true });
          expect(entry.status).toBe("ready");
          expect(entry.models?.[0]?.id).toBe(
            sharing === "shared" ? resolveSnapshotCwd("/tmp/plugin-a") : (cwd ?? "global-model"),
          );
        }
        expect(cwds).toEqual(expect.arrayContaining(expectedCwds));
        expect(cwds).toHaveLength(expectedCwds.length);
        for (const snapshot of published) {
          expect(snapshot.records).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                entry: expect.objectContaining({ provider: registration.id }),
              }),
            ]),
          );
        }
        expect(new Set(published.map((snapshot) => snapshot.cwd))).toEqual(
          new Set([
            GLOBAL_PROVIDER_SNAPSHOT_KEY,
            resolveSnapshotCwd("/tmp/plugin-a"),
            resolveSnapshotCwd("/tmp/plugin-b"),
          ]),
        );
        const lastFetchedAt = manager
          .getSnapshot(resolveSnapshotCwd("/tmp/plugin-a"))
          .records.find(({ entry }) => entry.provider === registration.id)!.entry.fetchedAt!;
        await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(lastFetchedAt)));
        published.length = 0;
        await manager.refreshSnapshotForCwd({
          cwd: resolveSnapshotCwd("/tmp/plugin-a"),
          providers: [registration.id],
        });
        const affectedCwds =
          sharing === "shared"
            ? [
                GLOBAL_PROVIDER_SNAPSHOT_KEY,
                resolveSnapshotCwd("/tmp/plugin-a"),
                resolveSnapshotCwd("/tmp/plugin-b"),
              ]
            : [resolveSnapshotCwd("/tmp/plugin-a")];
        expect(new Set(published.map((snapshot) => snapshot.cwd))).toEqual(new Set(affectedCwds));
        expect(published).toHaveLength(affectedCwds.length);
      } finally {
        await manager.shutdown();
        manager.destroy();
      }
    },
  );

  test("registers and unregisters plugin providers without rebuilding built-in clients", async () => {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const registration: ProviderRegistration = {
      id: "plugin-provider",
      label: "Plugin provider",
      async connect() {
        return {
          version: 1,
          capabilities: [],
          async send(input) {
            if (input.type !== "catalog") return;
            listener?.({
              type: "catalog",
              requestId: input.requestId,
              catalog: { models: [{ id: "plugin-model", label: "Plugin model" }], modes: [] },
            });
          },
          onEvent(nextListener) {
            listener = nextListener;
            return () => {
              if (listener === nextListener) listener = null;
            };
          },
          async close() {},
        };
      },
    };
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    try {
      const state = manager.replacePluginProviders([registration]);
      expect(state.clients[registration.id]?.provider).toBe(registration.id);
      await expect(
        manager.getProvider({ provider: registration.id, wait: true }),
      ).resolves.toMatchObject({
        provider: registration.id,
        source: "custom",
        status: "ready",
        models: [{ provider: registration.id, id: "plugin-model" }],
      });

      const withoutPlugin = manager.replacePluginProviders([]);
      expect(manager.hasProvider(registration.id)).toBe(false);
      expect(withoutPlugin.clients[registration.id]).toBeUndefined();
    } finally {
      await manager.shutdown();
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

describe("provider-owned catalogue identity", () => {
  const disabledProviders = {
    codex: { enabled: false },
    claude: { enabled: false },
    copilot: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
  };

  test("shares effective runtime/configuration keys, preserves targets, and isolates provider identities", async () => {
    const identities = new Map([
      [resolveSnapshotCwd("/a"), "runtime-1/config-1"],
      [resolveSnapshotCwd("/b"), "runtime-1/config-1"],
      [resolveSnapshotCwd("/c"), "runtime-2/config-1"],
    ]);
    const probes: Array<{ provider: string; options: FetchCatalogOptions | undefined }> = [];
    const discoveries: Array<{ provider: string; options: FetchCatalogOptions }> = [];
    const client = (provider: string) =>
      createExtraClient(provider, {
        async getCatalogCacheKey(options) {
          return options.scope === "workspace" ? identities.get(options.cwd) : undefined;
        },
        async isAvailable(_signal, options) {
          probes.push({ provider, options });
          return true;
        },
        async fetchCatalog(options) {
          discoveries.push({ provider, options });
          return {
            models: [{ provider, id: `${provider}-${discoveries.length}`, label: "Model" }],
            modes: [],
          };
        },
      });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        ...disabledProviders,
        first: { extends: "codex", label: "First", enabled: true },
        second: { extends: "codex", label: "Second", enabled: true },
      },
      extraClients: { first: client("first"), second: client("second") },
    });
    try {
      const read = (cwd: string, provider = "first") =>
        manager.getProvider({ provider, cwd, wait: true });
      const [a, b, c] = await Promise.all([
        read(resolveSnapshotCwd("/a")),
        read(resolveSnapshotCwd("/b")),
        read(resolveSnapshotCwd("/c")),
      ]);
      expect(a.models).toEqual(b.models);
      expect(c.models).not.toEqual(a.models);
      expect(discoveries).toHaveLength(2);
      expect(probes).toEqual(discoveries);
      expect(discoveries.map(({ options }) => options)).toEqual([
        { scope: "workspace", cwd: resolveSnapshotCwd("/a"), force: false },
        { scope: "workspace", cwd: resolveSnapshotCwd("/c"), force: false },
      ]);
      await read(resolveSnapshotCwd("/a"), "second");
      expect(discoveries).toHaveLength(3);
      identities.set(resolveSnapshotCwd("/b"), "runtime-2/config-1");
      expect((await read(resolveSnapshotCwd("/b"))).models).toEqual(c.models);
      expect(discoveries).toHaveLength(3);
      identities.set(resolveSnapshotCwd("/a"), "runtime-1/config-2");
      expect((await read(resolveSnapshotCwd("/a"))).models).not.toEqual(a.models);
      expect(discoveries).toHaveLength(4);
      await manager.refreshSnapshotForCwd({ cwd: resolveSnapshotCwd("/b"), providers: ["first"] });
      expect(discoveries).toHaveLength(5);
      expect(discoveries[4]?.options).toEqual({
        scope: "workspace",
        cwd: resolveSnapshotCwd("/b"),
        force: true,
      });
      expect((await read(resolveSnapshotCwd("/c"))).models).toEqual(
        (await read(resolveSnapshotCwd("/b"))).models,
      );
      expect(discoveries).toHaveLength(5);
      expect(probes).toEqual(discoveries);
    } finally {
      await manager.shutdown();
      manager.destroy();
    }
  });

  test("a refresh supersedes an older in-flight result for the same provider key", async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((finish) => {
      release = finish;
    });
    const began = new Promise<void>((finish) => {
      started = finish;
    });
    let calls = 0;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { ...disabledProviders, codex: { enabled: true } },
      extraClients: {
        codex: createExtraClient("codex", {
          async getCatalogCacheKey() {
            return "runtime/config";
          },
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            const call = ++calls;
            if (call === 1) {
              started();
              await pending;
            }
            return {
              models: [{ provider: "codex", id: `model-${call}`, label: "Model" }],
              modes: [],
            };
          },
        }),
      },
    });
    try {
      const first = manager.getProvider({
        provider: "codex",
        cwd: resolveSnapshotCwd("/a"),
        wait: true,
      });
      await began;
      await manager.refreshSnapshotForCwd({ cwd: resolveSnapshotCwd("/b"), providers: ["codex"] });
      release();
      await first;
      for (const cwd of [resolveSnapshotCwd("/a"), resolveSnapshotCwd("/b")]) {
        expect(
          (await manager.getProvider({ provider: "codex", cwd, wait: true })).models?.[0]?.id,
        ).toBe("model-2");
      }
      expect(calls).toBe(2);
    } finally {
      release();
      await manager.shutdown();
      manager.destroy();
    }
  });

  test("key lookup failure detaches a view from its previous shared catalogue", async () => {
    let broken = false;
    let calls = 0;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { ...disabledProviders, codex: { enabled: true } },
      extraClients: {
        codex: createExtraClient("codex", {
          async getCatalogCacheKey(options) {
            if (broken && options.scope === "workspace" && options.cwd === resolveSnapshotCwd("/a"))
              throw new Error("configuration unreadable");
            return "runtime/config";
          },
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            calls++;
            return {
              models: [{ provider: "codex", id: `model-${calls}`, label: "Model" }],
              modes: [],
            };
          },
        }),
      },
    });
    try {
      for (const cwd of [resolveSnapshotCwd("/a"), resolveSnapshotCwd("/b")])
        await manager.getProvider({ provider: "codex", cwd, wait: true });
      broken = true;
      expect(
        await manager.getProvider({ provider: "codex", cwd: resolveSnapshotCwd("/a"), wait: true }),
      ).toMatchObject({ status: "error", error: "configuration unreadable" });
      const published: string[] = [];
      manager.on("change", ({ current }) => published.push(current.cwd));
      await manager.refreshSnapshotForCwd({ cwd: resolveSnapshotCwd("/b"), providers: ["codex"] });
      expect(published).toEqual([resolveSnapshotCwd("/b")]);
      expect(calls).toBe(2);
    } finally {
      await manager.shutdown();
      manager.destroy();
    }
  });
});

test("late key resolution cannot restore an old identity and concurrent readers wait for discovery", async () => {
  let releaseKey!: () => void;
  let releaseCatalog!: () => void;
  let catalogStarted!: () => void;
  const keyPending = new Promise<void>((finish) => {
    releaseKey = finish;
  });
  const catalogPending = new Promise<void>((finish) => {
    releaseCatalog = finish;
  });
  const began = new Promise<void>((finish) => {
    catalogStarted = finish;
  });
  let keyCalls = 0;
  let probes = 0;
  const targets: FetchCatalogOptions[] = [];
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        async getCatalogCacheKey() {
          if (++keyCalls === 1) {
            await keyPending;
            return "old-runtime";
          }
          return "current-runtime";
        },
        async isAvailable() {
          probes++;
          return true;
        },
        async fetchCatalog(options) {
          targets.push(options);
          catalogStarted();
          await catalogPending;
          return { models: [{ provider: "codex", id: "current", label: "Current" }], modes: [] };
        },
      }),
    },
  });
  try {
    const first = manager.getProvider({
      provider: "codex",
      cwd: resolveSnapshotCwd("/project"),
      wait: true,
    });
    const second = manager.getProvider({
      provider: "codex",
      cwd: resolveSnapshotCwd("/project"),
      wait: true,
    });
    await began;
    const third = manager.getProvider({
      provider: "codex",
      cwd: resolveSnapshotCwd("/project"),
      wait: true,
    });
    releaseKey();
    releaseCatalog();
    const results = await Promise.all([first, second, third]);
    expect(results.map((result) => result.models?.[0]?.id)).toEqual([
      "current",
      "current",
      "current",
    ]);
    expect(targets).toEqual([
      { scope: "workspace", cwd: resolveSnapshotCwd("/project"), force: false },
    ]);
    expect(probes).toBe(1);
  } finally {
    releaseKey();
    releaseCatalog();
    await manager.shutdown();
    manager.destroy();
  }
});

test("settings refresh starts independent workspace discoveries together and shares equivalent catalogues", async () => {
  let release!: () => void;
  const pending = new Promise<void>((finish) => {
    release = finish;
  });
  let refreshing = false;
  const started: string[] = [];
  let sharedFetches = 0;
  const cwds = [resolveSnapshotCwd("/refresh-a"), resolveSnapshotCwd("/refresh-b")];
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      pi: createExtraClient("pi", {
        async isAvailable() {
          return true;
        },
        async fetchCatalog(options) {
          if (refreshing && options.scope === "workspace") {
            started.push(options.cwd);
            await pending;
          }
          return { models: [], modes: [] };
        },
      }),
      codex: createExtraClient("codex", {
        async isAvailable() {
          return true;
        },
        async fetchCatalog() {
          sharedFetches++;
          return { models: [], modes: [] };
        },
      }),
    },
  });
  let refresh: Promise<void> | undefined;
  try {
    await Promise.all(
      cwds.map((cwd) => manager.warmUpSnapshotForCwd({ cwd, providers: ["pi", "codex"] })),
    );
    expect(sharedFetches).toBe(1);
    refreshing = true;
    refresh = manager.refreshSettingsSnapshot({ providers: ["pi", "codex"] });
    await expect.poll(() => [...started].sort()).toEqual([...cwds].sort());
    expect(sharedFetches).toBe(2);
    release();
    await refresh;
  } finally {
    release();
    await refresh;
    await manager.shutdown();
    manager.destroy();
  }
});

test("bounds each provider across workspaces without blocking another provider", async () => {
  let release!: () => void;
  const pending = new Promise<void>((finish) => {
    release = finish;
  });
  let refreshing = false;
  let peerFetches = 0;
  let active = 0;
  let peak = 0;
  const started = new Set<string>();
  const updated = new Set<string>();
  const cwds = Array.from({ length: 16 }, (_, index) => resolveSnapshotCwd(`/bounded-${index}`));
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        async isAvailable() {
          return true;
        },
        async fetchCatalog() {
          peerFetches++;
          return { models: [], modes: [] };
        },
      }),
      pi: createExtraClient("pi", {
        async isAvailable(_signal, options) {
          if (refreshing && options?.scope === "workspace") {
            started.add(options.cwd);
            peak = Math.max(peak, ++active);
            await pending;
            active--;
          }
          return true;
        },
        async fetchCatalog() {
          return {
            models: [{ provider: "pi", id: refreshing ? "new" : "old", label: "Model" }],
            modes: [],
          };
        },
      }),
    },
  });
  const requests: Promise<void>[] = [];
  try {
    await Promise.all(cwds.map((cwd) => manager.warmUpSnapshotForCwd({ cwd, providers: ["pi"] })));
    manager.on("change", ({ current }) => {
      if (
        current.records.find((record) => record.entry.provider === "pi")?.entry.models?.[0]?.id ===
        "new"
      ) {
        updated.add(current.cwd);
      }
    });
    refreshing = true;
    requests.push(manager.refreshSettingsSnapshot({ providers: ["pi"] }));
    await expect.poll(() => started.size).toBeGreaterThanOrEqual(4);
    requests.push(manager.warmUpSnapshotForCwd({ cwd: "/concurrent-read", providers: ["pi"] }));
    expect(peak).toBe(4);
    requests.push(
      manager.warmUpSnapshotForCwd({ cwd: "/independent-provider", providers: ["codex"] }),
    );
    await expect.poll(() => peerFetches).toBe(1);
    release();
    await Promise.all(requests);
    expect(started.size).toBe(cwds.length + 1);
    expect(peak).toBe(4);
    // Other sessions receive refreshed views without initiating a scoped read.
    expect(cwds.every((cwd) => updated.has(cwd))).toBe(true);
  } finally {
    release();
    await Promise.all(requests);
    await manager.shutdown();
    manager.destroy();
  }
});

test.each(["configuration", "shutdown", "destroy"])(
  "discards queued discovery after %s",
  async (action) => {
    let release!: () => void;
    const pending = new Promise<void>((finish) => {
      release = finish;
    });
    const calls: string[] = [];
    let keys = 0;
    const cwds = Array.from({ length: 5 }, (_, index) => resolveSnapshotCwd(`/queued-${index}`));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { ...PUBLICATION_PROVIDERS, pi: { enabled: true, label: "Initial" } },
      extraClients: {
        pi: createExtraClient("pi", {
          async getCatalogCacheKey() {
            keys++;
            return undefined;
          },
          async isAvailable() {
            return true;
          },
          async fetchCatalog(options) {
            if (options.scope === "workspace") calls.push(options.cwd);
            await pending;
            return { models: [], modes: [] };
          },
        }),
      },
    });
    const requests = cwds.map((cwd) => manager.warmUpSnapshotForCwd({ cwd, providers: ["pi"] }));
    let transitions = 0;
    manager.on("change", () => {
      transitions++;
    });
    try {
      await expect.poll(() => keys).toBe(5);
      await expect.poll(() => calls.length).toBeGreaterThanOrEqual(4);
      expect(calls).toEqual(cwds.slice(0, 4));
      let queuedSettled = false;
      void requests[4]!.then(() => {
        queuedSettled = true;
        return undefined;
      });
      if (action === "configuration") {
        manager.applyMutableProviderConfig({
          ...PUBLICATION_PROVIDERS,
          pi: { enabled: true, label: "Updated" },
        });
        await expect.poll(() => queuedSettled).toBe(true);
        // Replacing configuration must not reset the budget for still-active probes.
        expect(calls).toEqual(cwds.slice(0, 4));
        release();
        await manager.warmUpSnapshotForCwd({ cwd: cwds[4], providers: ["pi"] });
        await Promise.all(requests);
        expect(calls.filter((cwd) => cwd === cwds[4])).toHaveLength(1);
      } else {
        const beforeStop = transitions;
        if (action === "shutdown") await manager.shutdown();
        else manager.destroy();
        await expect.poll(() => queuedSettled).toBe(true);
        release();
        await Promise.all(requests);
        expect(calls).toEqual(cwds.slice(0, 4));
        expect(transitions).toBe(beforeStop);
      }
    } finally {
      release();
      await Promise.all(requests);
      await manager.shutdown();
      manager.destroy();
    }
  },
);

test("settings invalidation discards pending discovery even when the provider returns the same key", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((finish) => {
    release = finish;
  });
  const began = new Promise<void>((finish) => {
    started = finish;
  });
  let calls = 0;
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        async getCatalogCacheKey() {
          return "host";
        },
        async isAvailable() {
          return true;
        },
        async fetchCatalog() {
          const call = ++calls;
          if (call === 1) {
            started();
            await pending;
          }
          return {
            models: [{ provider: "codex", id: `model-${call}`, label: "Model" }],
            modes: [],
          };
        },
      }),
    },
  });
  try {
    const old = manager.getProvider({
      provider: "codex",
      cwd: resolveSnapshotCwd("/project"),
      wait: true,
    });
    await began;
    await manager.refreshSettingsSnapshot({ providers: ["codex"] });
    release();
    await old;
    expect(
      (
        await manager.getProvider({
          provider: "codex",
          cwd: resolveSnapshotCwd("/project"),
          wait: true,
        })
      ).models?.[0]?.id,
    ).toBe("model-2");
    expect(calls).toBe(2);
  } finally {
    release();
    await manager.shutdown();
    manager.destroy();
  }
});

test("an unchanged provider publishes a pending key failure after an unrelated config reload", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((finish) => {
    release = finish;
  });
  const began = new Promise<void>((finish) => {
    started = finish;
  });
  const config = {
    codex: { enabled: true },
    claude: { enabled: false },
    copilot: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
    omp: { enabled: false },
  };
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: config,
    extraClients: {
      codex: createExtraClient("codex", {
        async getCatalogCacheKey() {
          started();
          await pending;
          throw new Error("unreadable config");
        },
      }),
    },
  });
  try {
    const read = manager.getProvider({
      provider: "codex",
      cwd: resolveSnapshotCwd("/project"),
      wait: true,
    });
    await began;
    manager.applyMutableProviderConfig(
      { ...config, claude: { enabled: false, label: "Changed" } },
      { replace: true },
    );
    release();
    expect(await read).toMatchObject({ status: "error", error: "unreadable config" });
  } finally {
    release();
    await manager.shutdown();
    manager.destroy();
  }
});

test("a concurrent cached read cannot swallow a force refresh while its key is resolving", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((finish) => {
    release = finish;
  });
  const began = new Promise<void>((finish) => {
    started = finish;
  });
  let keyCalls = 0;
  let calls = 0;
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        async getCatalogCacheKey() {
          if (++keyCalls === 2) {
            started();
            await pending;
          }
          return "host";
        },
        async isAvailable() {
          return true;
        },
        async fetchCatalog() {
          return {
            models: [{ provider: "codex", id: `model-${++calls}`, label: "Model" }],
            modes: [],
          };
        },
      }),
    },
  });
  const cwd = resolveSnapshotCwd("/project");
  try {
    await manager.getProvider({ provider: "codex", cwd, wait: true });
    const refresh = manager.refreshSnapshotForCwd({ providers: ["codex"], cwd });
    await began;
    const read = manager.getProvider({ provider: "codex", cwd, wait: true });
    release();
    await refresh;
    expect((await read).models?.[0]?.id).toBe("model-2");
    expect(calls).toBe(2);
  } finally {
    release();
    await manager.shutdown();
    manager.destroy();
  }
});

test.each(["workspace", "settings"])(
  "%s refresh retains the settled catalogue and publishes only the next result",
  async (scope) => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((finish) => {
      release = finish;
    });
    const began = new Promise<void>((finish) => {
      started = finish;
    });
    let calls = 0;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: PUBLICATION_PROVIDERS,
      extraClients: {
        codex: createExtraClient("codex", {
          getCatalogCacheKey: async () => "shared",
          async isAvailable() {
            return true;
          },
          async fetchCatalog() {
            if (++calls === 2) {
              started();
              await pending;
            }
            return {
              models: [{ provider: "codex", id: "astra", label: `Astra ${calls}` }],
              modes: [],
            };
          },
        }),
      },
    });
    try {
      await manager.getProvider({ provider: "codex", cwd: "/project", wait: true });
      const before = manager.getSnapshot("/project");
      await manager.warmUpSnapshotForCwd({ cwd: "/project", providers: ["codex"] });
      const statuses: string[] = [];
      manager.on("change", ({ current }) => {
        if (current.cwd !== resolveSnapshotCwd("/project")) return;
        statuses.push(
          current.records.find(({ entry }) => entry.provider === "codex")!.entry.status,
        );
      });
      const refresh =
        scope === "workspace"
          ? manager.refreshSnapshotForCwd({ cwd: "/project", providers: ["codex"] })
          : manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await began;
      expect(statuses).toEqual([]);
      expect(manager.getSnapshot("/project")).toBe(before);
      expect(
        await manager.getProvider({ provider: "codex", cwd: "/project", wait: false }),
      ).toMatchObject({ status: "ready", models: [{ id: "astra", label: "Astra 1" }] });
      release();
      await refresh;
      expect(statuses).toEqual(["ready"]);
      expect(
        await manager.getProvider({ provider: "codex", cwd: "/project", wait: true }),
      ).toMatchObject({ status: "ready", models: [{ id: "astra", label: "Astra 2" }] });
      expect(calls).toBe(2);
    } finally {
      release();
      manager.destroy();
    }
  },
);

test("publication detaches provider-retained arrays, thinking options and nested metadata", async () => {
  const models: AgentModelDefinition[] = [
    {
      provider: "codex",
      id: "astra",
      label: "Astra",
      thinkingOptions: [{ id: "high", label: "High" }],
      metadata: { nested: { label: "original" } },
    },
  ];
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        isAvailable: async () => true,
        fetchCatalog: async () => ({ models, modes: [] }),
      }),
    },
  });
  try {
    const published = await manager.getProvider({ provider: "codex", wait: true });
    const record = manager.getSnapshot().records.find(({ entry }) => entry.provider === "codex")!;
    const originalRecord = structuredClone(record);
    const original = structuredClone(published);
    models.push({ provider: "codex", id: "late", label: "Late" });
    models[0]!.thinkingOptions![0]!.label = "mutated";
    (models[0]!.metadata!.nested as { label: string }).label = "mutated";
    expect(record).toEqual(originalRecord);
    expect(published).toBe(record.entry);
    expect(published).toEqual(original);
    expect(await manager.getProvider({ provider: "codex" })).toEqual(original);
  } finally {
    await manager.shutdown();
    manager.destroy();
  }
});

test("snapshot records share provider results across targets while retaining target-specific catalogues", async () => {
  const calls = { codex: 0, opencode: 0 };
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: Object.fromEntries(
      (["codex", "opencode"] as const).map((provider) => [
        provider,
        createExtraClient(provider, {
          isAvailable: async () => true,
          fetchCatalog: async (options) => {
            calls[provider]++;
            const target = options.scope === "workspace" ? options.cwd : "global";
            const id = provider === "codex" ? "shared" : target;
            return { models: [{ provider, id, label: id }], modes: [] };
          },
        }),
      ]),
    ),
  });
  try {
    const targets = [undefined, "/tmp/identity-a", "/tmp/identity-b"];
    await Promise.all(
      targets.map((cwd) =>
        manager.listProviders({ cwd, providers: ["codex", "opencode"], wait: true }),
      ),
    );
    const snapshots = targets.map((cwd) => manager.getSnapshot(cwd));
    const shared = snapshots.map(
      ({ records }) => records.find(({ entry }) => entry.provider === "codex")!,
    );
    expect(shared[0]).toBe(shared[1]);
    expect(shared[1]).toBe(shared[2]);
    expect(
      new Set(
        snapshots.map(
          ({ records }) => records.find(({ entry }) => entry.provider === "opencode")!.contentHash,
        ),
      ).size,
    ).toBe(3);
    expect(calls).toEqual({ codex: 1, opencode: 3 });
    expect(await manager.getProvider({ provider: "codex", cwd: targets[1] })).toBe(
      shared[0]!.entry,
    );
  } finally {
    await manager.shutdown();
    manager.destroy();
  }
});

test("result identity covers content, metadata and status while unchanged refresh advances only freshness", async () => {
  const model: AgentModelDefinition = {
    provider: "codex",
    id: "astra",
    label: "Astra",
    metadata: { revision: 1 },
  };
  let available = true;
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: {
      codex: createExtraClient("codex", {
        isAvailable: async () => available,
        fetchCatalog: async () => ({ models: [model], modes: [] }),
      }),
    },
  });
  const read = () => manager.getSnapshot().records.find(({ entry }) => entry.provider === "codex")!;
  const refresh = () => manager.refreshSettingsSnapshot({ providers: ["codex"] });
  try {
    await manager.getProvider({ provider: "codex", wait: true });
    const first = read();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(first.entry.fetchedAt!)));
    await refresh();
    const fresh = read();
    expect(fresh).not.toBe(first);
    expect(fresh.contentHash).toBe(first.contentHash);
    expect(Date.parse(fresh.entry.fetchedAt!)).toBeGreaterThan(Date.parse(first.entry.fetchedAt!));
    model.label = "Astra updated";
    await refresh();
    const content = read();
    expect(content.contentHash).not.toBe(fresh.contentHash);
    model.metadata!.revision = 2;
    await refresh();
    const metadata = read();
    expect(metadata.contentHash).not.toBe(content.contentHash);
    available = false;
    await refresh();
    const unavailable = read();
    expect(unavailable.entry.status).toBe("unavailable");
    expect(unavailable.contentHash).not.toBe(metadata.contentHash);
  } finally {
    await manager.shutdown();
    manager.destroy();
  }
});

const PUBLICATION_PROVIDERS = Object.fromEntries(
  ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => [
    provider,
    { enabled: provider === "codex" },
  ]),
);

test("reads retain the target snapshot and cold binding publishes only the resolved transition", async () => {
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: PUBLICATION_PROVIDERS,
    extraClients: { codex: createExtraClient("codex", { isAvailable: async () => true }) },
  });
  const changes: unknown[] = [];
  manager.on("change", (change) => changes.push(change));
  try {
    const initial = manager.getSnapshot("/tmp/published");
    expect(manager.getSnapshot("/tmp/published")).toBe(initial);
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/published" });
    const ready = manager.getSnapshot("/tmp/published");
    expect(ready).not.toBe(initial);
    expect(manager.getSnapshot("/tmp/published")).toBe(ready);
    expect(changes).toEqual([{ previous: initial, current: ready }]);
  } finally {
    manager.destroy();
  }
});

test("identical key failures and unavailable results complete without duplicate transitions", async () => {
  let keyFails = true;
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: PUBLICATION_PROVIDERS,
    extraClients: {
      codex: createExtraClient("codex", {
        getCatalogCacheKey: async () => {
          if (keyFails) throw new Error("same key failure");
          return "host";
        },
      }),
    },
  });
  const changes: unknown[] = [];
  manager.on("change", (change) => changes.push(change));
  try {
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/failure" });
    const failed = manager.getSnapshot("/tmp/failure");
    changes.length = 0;
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/failure" });
    expect(changes).toEqual([]);
    expect(manager.getSnapshot("/tmp/failure")).toBe(failed);
    keyFails = false;
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/failure" });
    const unavailable = manager.getSnapshot("/tmp/failure");
    changes.length = 0;
    await manager.refreshSnapshotForCwd({ cwd: "/tmp/failure", providers: ["codex"] });
    expect(changes).toEqual([]);
    expect(manager.getSnapshot("/tmp/failure")).toBe(unavailable);
  } finally {
    manager.destroy();
  }
});

test("shared result publication installs every target before notifying the first subscriber", async () => {
  let label = "before";
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: PUBLICATION_PROVIDERS,
    extraClients: {
      codex: createExtraClient("codex", {
        isAvailable: async () => true,
        fetchCatalog: async () => ({
          models: [{ provider: "codex", id: "astra", label }],
          modes: [],
        }),
      }),
    },
  });
  const targets = ["/tmp/atomic-a", "/tmp/atomic-b"];
  try {
    await Promise.all(targets.map((cwd) => manager.warmUpSnapshotForCwd({ cwd })));
    const observed: ProviderSnapshot[][] = [];
    manager.on("change", () => observed.push(targets.map((cwd) => manager.getSnapshot(cwd))));
    label = "after";
    await manager.refreshSnapshotForCwd({ cwd: targets[0]!, providers: ["codex"] });
    expect(observed).toHaveLength(2);
    for (const snapshots of observed) {
      expect(snapshots).toHaveLength(2);
      for (const snapshot of snapshots) {
        expect(
          snapshot.records.find(({ entry }) => entry.provider === "codex")!.entry.models![0]!.label,
        ).toBe("after");
      }
    }
  } finally {
    manager.destroy();
  }
});

test("plugin runtime replacement invalidates only changed registrations and commits all targets together", async () => {
  const calls: string[] = [];
  const closed: string[] = [];
  function registration(id: string, model: string): ProviderRegistration {
    return {
      id,
      label: id,
      getCatalogCacheKey: async () => "host",
      async connect() {
        let listener: ((event: ProviderEvent) => void) | undefined;
        return {
          version: 1,
          capabilities: [],
          async send(input) {
            if (input.type !== "catalog") return;
            calls.push(model);
            listener?.({
              type: "catalog",
              requestId: input.requestId,
              catalog: { models: [{ id: model, label: model }], modes: [] },
            });
          },
          onEvent(next) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async close() {
            closed.push(model);
          },
        };
      },
    };
  }
  const first = registration("first-plugin", "first");
  const second = registration("second-plugin", "second");
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: PUBLICATION_PROVIDERS,
    extraClients: {
      codex: createExtraClient("codex", {
        isAvailable: async () => true,
        fetchCatalog: async () => {
          calls.push("codex");
          return { models: [], modes: [] };
        },
      }),
    },
  });
  const cwds = ["/tmp/plugin-install-a", "/tmp/plugin-install-b"];
  const warm = () => Promise.all(cwds.map((cwd) => manager.warmUpSnapshotForCwd({ cwd })));
  try {
    manager.replacePluginProviders([first, second]);
    await warm();
    const clients = manager.getAgentManagerProviderState().clients;
    const snapshots = cwds.map((cwd) => manager.getSnapshot(cwd));
    const observed: ProviderSnapshot[][] = [];
    manager.on("change", () => observed.push(cwds.map((cwd) => manager.getSnapshot(cwd))));
    manager.replacePluginProviders([first, second]);
    await warm();
    expect(calls.toSorted()).toEqual(["codex", "first", "second"]);
    expect(manager.getSnapshot(cwds[0])).toBe(snapshots[0]);
    expect(observed).toEqual([]);
    manager.replacePluginProviders([registration("first-plugin", "restarted"), second]);
    const loading = cwds.map((cwd) => manager.getSnapshot(cwd));
    expect(observed).toHaveLength(2);
    for (const reads of observed) {
      expect(reads[0]).toBe(loading[0]);
      expect(reads[1]).toBe(loading[1]);
    }
    const nextClients = manager.getAgentManagerProviderState().clients;
    expect(nextClients.codex).toBe(clients.codex);
    expect(nextClients["second-plugin"]).toBe(clients["second-plugin"]);
    expect(nextClients["first-plugin"]).not.toBe(clients["first-plugin"]);
    expect(loading[0]!.records.find(({ entry }) => entry.provider === "codex")).toBe(
      snapshots[0]!.records.find(({ entry }) => entry.provider === "codex"),
    );
    expect(loading[0]!.records.find(({ entry }) => entry.provider === "second-plugin")).toBe(
      snapshots[0]!.records.find(({ entry }) => entry.provider === "second-plugin"),
    );
    expect(
      loading[0]!.records.find(({ entry }) => entry.provider === "first-plugin")!.entry.status,
    ).toBe("loading");
    await warm();
    expect(calls.toSorted()).toEqual(["codex", "first", "restarted", "second"]);
    expect(
      manager.getSnapshot(cwds[0]).records.find(({ entry }) => entry.provider === "first-plugin")!
        .entry.models![0]!.id,
    ).toBe("restarted");
    manager.replacePluginProviders([second]);
    await warm();
    expect(manager.hasProvider("first-plugin")).toBe(false);
    expect(closed.toSorted()).toEqual(["first", "restarted"]);
    await manager.shutdown();
    expect(closed.toSorted()).toEqual(["first", "restarted", "second"]);
    expect(calls.toSorted()).toEqual(["codex", "first", "restarted", "second"]);
  } finally {
    await manager.shutdown();
    manager.destroy();
  }
});

test("binding a settled catalogue publishes once and rebinding an equal settled result publishes nothing", async () => {
  let key = "first";
  let probes = 0;
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides: PUBLICATION_PROVIDERS,
    extraClients: {
      codex: createExtraClient("codex", {
        getCatalogCacheKey: async () => key,
        isAvailable: async () => {
          probes++;
          return false;
        },
      }),
    },
  });
  const transitions: unknown[] = [];
  manager.on("change", (transition) => transitions.push(transition));
  try {
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/bind-a" });
    transitions.length = 0;
    const initial = manager.getSnapshot("/tmp/bind-b");
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/bind-b" });
    expect(transitions).toEqual([
      { previous: initial, current: manager.getSnapshot("/tmp/bind-b") },
    ]);
    expect(probes).toBe(1);
    key = "second";
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/bind-b" });
    const retained = manager.getSnapshot("/tmp/bind-a");
    transitions.length = 0;
    await manager.warmUpSnapshotForCwd({ cwd: "/tmp/bind-a" });
    expect(transitions).toEqual([]);
    expect(manager.getSnapshot("/tmp/bind-a")).toBe(retained);
    expect(probes).toBe(2);
  } finally {
    manager.destroy();
  }
});
