import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import type { PersistedConfig } from "../persisted-config.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  FetchCatalogOptions,
} from "./agent-sdk-types.js";
import { attachMutableProviderConfigOwner } from "./mutable-provider-config-owner.js";
import {
  type ProviderSnapshotTransition,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

const tempDirs: string[] = [];
const CONTROLLED_PROVIDERS = {
  claude: { enabled: false },
  codex: { enabled: true },
  copilot: { enabled: false },
  omp: { enabled: false },
  opencode: { enabled: false },
  pi: { enabled: false },
} as const;

interface Catalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
}

function controlledCodexClient(fetchCatalog: (options: FetchCatalogOptions) => Promise<Catalog>) {
  return {
    provider: "codex",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    isAvailable: async () => true,
    fetchCatalog,
  } satisfies AgentClient;
}

function catalog(modelId: string): Catalog {
  return {
    models: [{ provider: "codex", id: modelId, label: modelId }],
    modes: [],
  };
}

function recordCodexEvent(events: string[]): (transition: ProviderSnapshotTransition) => void {
  return ({ current }) => {
    const codex = current.records.find(({ entry }) => entry.provider === "codex")?.entry;
    events.push(`${codex?.status}:${codex?.models?.[0]?.id ?? "none"}`);
  };
}

function getCodexSnapshot(manager: ProviderSnapshotManager, cwd: string) {
  return manager.getSnapshot(cwd).records.find(({ entry }) => entry.provider === "codex")?.entry;
}

function mutableConfig(persisted: PersistedConfig): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { enabled: true, injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: CONTROLLED_PROVIDERS,
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    cors: { allowedOrigins: persisted.daemon?.cors?.allowedOrigins ?? [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: persisted.daemon?.git?.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: persisted.daemon?.git?.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: persisted.app?.baseUrl ?? "https://app.paseo.sh" },
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("mutable provider config owner", () => {
  test("publishes provider changes after commit and emits nothing on rollback", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: true } },
    });
    const cwd = path.resolve("/tmp/provider-config-owner");
    manager.getSnapshot(cwd);
    const events: string[] = [];
    manager.on("change", ({ current }) => events.push(current.cwd));
    let agentManagerState = manager.getAgentManagerProviderState();
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: (state) => {
        agentManagerState = state;
      },
    });
    const unsubscribeTimingCheck = store.onApply(() => {
      expect(events).toEqual([]);
      return () => undefined;
    });

    try {
      store.patch({ providers: { codex: { enabled: false } } });
      expect(events).toEqual([cwd]);
      expect(agentManagerState.providerDefinitions.codex).toMatchObject({ enabled: false });

      events.length = 0;
      const unsubscribeFailure = store.onApply(() => {
        throw new Error("later owner failed");
      });
      expect(() => store.patch({ providers: { codex: { enabled: true } } })).toThrow(
        "later owner failed",
      );
      unsubscribeFailure();

      expect(events).toEqual([]);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: false,
      });
      expect(agentManagerState.providerDefinitions.codex).toMatchObject({ enabled: false });
    } finally {
      unsubscribeTimingCheck();
      unsubscribe();
      manager.destroy();
    }
  });

  test("does no provider work for unrelated CORS, Git, and app URL reloads", () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const initial: PersistedConfig = {
      version: 1,
      daemon: {
        cors: { allowedOrigins: ["https://before.example.test"] },
        git: { maxProcessesPerSecond: 64, maxProcessConcurrency: 8 },
      },
      app: { baseUrl: "https://before.example.test" },
    };
    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`, "utf-8");
    const store = new DaemonConfigStore(paseoHome, mutableConfig(initial), undefined, {
      startupPersisted: initial,
      reloadSource: {
        resolve: (persisted) => ({
          mutable: mutableConfig(persisted),
          overrideControlledPaths: [],
        }),
      },
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: true } },
    });
    manager.getSnapshot("/tmp/provider-config-owner");
    const events: string[] = [];
    manager.on("change", ({ current }) => events.push(current.cwd));
    let registryUpdates = 0;
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => {
        registryUpdates += 1;
      },
    });

    try {
      const reloaded: PersistedConfig = {
        ...initial,
        daemon: {
          ...initial.daemon,
          cors: { allowedOrigins: ["https://after.example.test"] },
          git: { maxProcessesPerSecond: 5, maxProcessConcurrency: 1 },
        },
        app: { baseUrl: "https://after.example.test" },
      };
      writeFileSync(configPath, `${JSON.stringify(reloaded, null, 2)}\n`, "utf-8");

      expect(store.reload().appliedPaths).toEqual([
        "app.baseUrl",
        "daemon.cors.allowedOrigins",
        "daemon.git.maxProcessConcurrency",
        "daemon.git.maxProcessesPerSecond",
      ]);
      expect(events).toEqual([]);
      expect(registryUpdates).toBe(0);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: true,
      });
    } finally {
      unsubscribe();
      manager.destroy();
    }
  });

  test("replaces an in-flight catalog after provider config commits", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const catalogResolvers: Array<(value: Catalog) => void> = [];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: {
        codex: controlledCodexClient(
          () => new Promise((resolve) => catalogResolvers.push(resolve)),
        ),
      },
    });
    const cwd = path.resolve("/tmp/provider-config-commit");
    const events: string[] = [];
    manager.on("change", recordCodexEvent(events));
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });

    try {
      const originalRead = manager.getProvider({ cwd, provider: "codex", wait: true });
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(1));
      expect(events).toEqual([]);

      store.patch({ providers: { codex: { enabled: true, label: "Reloaded Codex" } } });
      expect(events).toEqual(["loading:none"]);
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(2));

      catalogResolvers[0]?.(catalog("stale-model"));
      await originalRead;
      expect(events).toEqual(["loading:none"]);

      catalogResolvers[1]?.(catalog("current-model"));
      await vi.waitFor(() =>
        expect(getCodexSnapshot(manager, cwd)).toMatchObject({
          status: "ready",
          models: [{ id: "current-model" }],
        }),
      );
      expect(events).toEqual(["loading:none", "ready:current-model"]);
    } finally {
      unsubscribe();
      manager.destroy();
    }
  });

  test("lets the original in-flight catalog publish after provider config rolls back", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const catalogResolvers: Array<(value: Catalog) => void> = [];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: {
        codex: controlledCodexClient(
          () => new Promise((resolve) => catalogResolvers.push(resolve)),
        ),
      },
    });
    const cwd = path.resolve("/tmp/provider-config-rollback");
    const events: string[] = [];
    manager.on("change", recordCodexEvent(events));
    const previousState = manager.getAgentManagerProviderState();
    let agentManagerState = previousState;
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: (state) => {
        agentManagerState = state;
      },
    });
    const observedDuringApply: Array<{
      label: string;
      snapshot: ReturnType<ProviderSnapshotManager["getSnapshot"]>;
    }> = [];
    const unsubscribeFailure = store.onApply(() => {
      observedDuringApply.push({
        label: manager.getProviderLabel("codex"),
        snapshot: manager.getSnapshot(cwd),
      });
      throw new Error("later owner failed");
    });

    try {
      const originalRead = manager.getProvider({ cwd, provider: "codex", wait: true });
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(1));
      expect(events).toEqual([]);

      const before = manager.getSnapshot(cwd);
      expect(() =>
        store.patch({ providers: { codex: { enabled: true, label: "Rejected Codex" } } }),
      ).toThrow("later owner failed");
      expect(events).toEqual([]);
      expect(observedDuringApply).toEqual([{ label: "Codex", snapshot: before }]);
      expect(observedDuringApply[0]!.snapshot).toBe(before);
      expect(manager.getSnapshot(cwd)).toBe(before);
      expect(agentManagerState).toEqual(previousState);
      expect(agentManagerState.clients.codex).toBe(previousState.clients.codex);

      catalogResolvers[0]?.(catalog("original-model"));
      await expect(originalRead).resolves.toMatchObject({
        status: "ready",
        models: [{ id: "original-model" }],
      });
      expect(getCodexSnapshot(manager, cwd)).toMatchObject({
        status: "ready",
        models: [{ id: "original-model" }],
      });
      expect(events).toEqual(["ready:original-model"]);
      expect(catalogResolvers).toHaveLength(1);
    } finally {
      unsubscribeFailure();
      unsubscribe();
      manager.destroy();
    }
  });
});
