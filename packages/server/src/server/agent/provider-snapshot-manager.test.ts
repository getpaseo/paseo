import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ProviderDefinition } from "./provider-registry.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type MockProviderOptions = {
  provider: AgentProvider;
  label?: string;
  description?: string;
  defaultModeId?: string | null;
  isAvailable?: () => Promise<boolean>;
  fetchModels?: (cwd?: string) => Promise<AgentModelDefinition[]>;
  fetchModes?: (cwd?: string) => Promise<AgentMode[]>;
};

type MockProviderHandle = {
  definition: ProviderDefinition;
  isAvailable: ReturnType<typeof vi.fn>;
  fetchModels: ReturnType<typeof vi.fn>;
  fetchModes: ReturnType<typeof vi.fn>;
};

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

describe("ProviderSnapshotManager", () => {
  const ttlMs = 5 * 60 * 1_000;
  const projectCwd = resolve("/tmp/project");
  const projectACwd = resolve("/tmp/project-a");
  const projectBCwd = resolve("/tmp/project-b");

  test("getSnapshot returns all providers in loading state initially and triggers warmUp", async () => {
    const codexModels = deferred<AgentModelDefinition[]>();
    const claudeModels = deferred<AgentModelDefinition[]>();
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => codexModels.promise,
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: async () => claudeModels.promise,
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    const snapshot = manager.getSnapshot(projectCwd);

    expect(snapshot.map((entry) => entry.provider)).toEqual(["codex", "claude"]);
    expect(getProviderEntry(snapshot, "claude")).toMatchObject({
      provider: "claude",
      status: "loading",
      label: "claude",
      description: "claude test provider",
      defaultModeId: null,
    });
    expect(getProviderEntry(snapshot, "codex")).toMatchObject({
      provider: "codex",
      status: "loading",
      label: "codex",
      description: "codex test provider",
      defaultModeId: null,
    });

    await vi.waitFor(() => {
      expect(handles.claude?.isAvailable).toHaveBeenCalledTimes(1);
      expect(handles.codex?.isAvailable).toHaveBeenCalledTimes(1);
    });

    manager.destroy();
    codexModels.resolve([]);
    claudeModels.resolve([]);
  });

  test("after warmUp completes, getSnapshot returns ready entries with models", async () => {
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => [createModel("codex", "gpt-5.2")],
        fetchModes: async () => [createMode("auto")],
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: async () => [createModel("claude", "sonnet")],
        fetchModes: async () => [createMode("default")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.status).toBe("ready");
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
    });

    const snapshot = manager.getSnapshot(projectCwd);
    expect(getProviderEntry(snapshot, "codex")).toMatchObject({
      provider: "codex",
      status: "ready",
      models: [createModel("codex", "gpt-5.2")],
      modes: [createMode("auto")],
      label: "codex",
      description: "codex test provider",
      defaultModeId: null,
    });
    expect(getProviderEntry(snapshot, "claude")).toMatchObject({
      provider: "claude",
      status: "ready",
      models: [createModel("claude", "sonnet")],
      modes: [createMode("default")],
      label: "claude",
      description: "claude test provider",
      defaultModeId: null,
    });
    expect(getProviderEntry(snapshot, "codex")?.fetchedAt).toEqual(expect.any(String));

    manager.destroy();
  });

  test("provider that fails isAvailable shows as unavailable", async () => {
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        isAvailable: async () => false,
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(manager.getSnapshot(projectCwd)).toEqual([
        {
          provider: "codex",
          status: "unavailable",
          label: "codex",
          description: "codex test provider",
          defaultModeId: null,
        },
      ]);
    });

    expect(handles.codex?.fetchModels).not.toHaveBeenCalled();
    expect(handles.codex?.fetchModes).not.toHaveBeenCalled();

    manager.destroy();
  });

  test("provider that fails fetchModels shows as error with error message", async () => {
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => {
          throw new Error("model lookup failed");
        },
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(manager.getSnapshot(projectCwd)).toEqual([
        {
          provider: "codex",
          status: "error",
          error: "model lookup failed",
          label: "codex",
          description: "codex test provider",
          defaultModeId: null,
        },
      ]);
    });

    manager.destroy();
  });

  test("change event fires for each provider as it resolves", async () => {
    const codexModels = deferred<AgentModelDefinition[]>();
    const claudeModels = deferred<AgentModelDefinition[]>();
    const codexModes = deferred<AgentMode[]>();
    const claudeModes = deferred<AgentMode[]>();
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => codexModels.promise,
        fetchModes: async () => codexModes.promise,
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: async () => claudeModels.promise,
        fetchModes: async () => claudeModes.promise,
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());
    const changes: Array<{ cwd: string; entries: ProviderSnapshotEntry[] }> = [];
    const listener = (entries: ProviderSnapshotEntry[], cwd: string) => {
      changes.push({ cwd, entries });
    };
    manager.on("change", listener);

    manager.getSnapshot(projectCwd);

    claudeModels.resolve([createModel("claude", "sonnet")]);
    claudeModes.resolve([createMode("default")]);

    await vi.waitFor(() => {
      expect(changes).toHaveLength(1);
    });

    expect(changes[0]?.cwd).toBe(projectCwd);
    expect(getProviderEntry(changes[0]?.entries ?? [], "claude")?.status).toBe("ready");
    expect(getProviderEntry(changes[0]?.entries ?? [], "codex")?.status).toBe("loading");

    codexModels.resolve([createModel("codex", "gpt-5.2")]);
    codexModes.resolve([createMode("auto")]);

    await vi.waitFor(() => {
      expect(changes).toHaveLength(2);
    });

    expect(getProviderEntry(changes[1]?.entries ?? [], "codex")?.status).toBe("ready");
    expect(getProviderEntry(changes[1]?.entries ?? [], "claude")?.status).toBe("ready");

    manager.off("change", listener);
    manager.destroy();
  });

  test("refresh re-fetches and updates entries", async () => {
    const codexFetchModels = vi
      .fn<(options?: { cwd?: string }) => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockResolvedValueOnce([createModel("codex", "gpt-5.2")]);
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async (cwd) => codexFetchModels({ cwd }),
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
    });

    manager.refresh({ cwd: projectCwd });
    expect(manager.getSnapshot(projectCwd)).toEqual([
      {
        provider: "codex",
        status: "loading",
        label: "codex",
        description: "codex test provider",
        defaultModeId: null,
      },
    ]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    expect(codexFetchModels).toHaveBeenCalledTimes(2);

    manager.destroy();
  });

  test("refresh with providers only re-fetches matching providers", async () => {
    const codexFetchModels = vi
      .fn<() => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockResolvedValueOnce([createModel("codex", "gpt-5.2")]);
    const claudeFetchModels = vi
      .fn<() => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("claude", "sonnet-4")]);
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: codexFetchModels,
        fetchModes: async () => [createMode("auto")],
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: claudeFetchModels,
        fetchModes: async () => [createMode("default")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.models?.[0]?.id).toBe(
        "sonnet-4",
      );
    });

    manager.refresh({ cwd: projectCwd, providers: ["codex"] });

    expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("loading");
    expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")).toMatchObject({
      provider: "claude",
      status: "ready",
      models: [createModel("claude", "sonnet-4")],
    });

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    expect(codexFetchModels).toHaveBeenCalledTimes(2);
    expect(claudeFetchModels).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  test("refresh treats an empty providers list as a full refresh", async () => {
    const codexFetchModels = vi
      .fn<() => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockResolvedValueOnce([createModel("codex", "gpt-5.2")]);
    const claudeFetchModels = vi
      .fn<() => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("claude", "sonnet-4")])
      .mockResolvedValueOnce([createModel("claude", "sonnet-4.5")]);
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: codexFetchModels,
        fetchModes: async () => [createMode("auto")],
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: claudeFetchModels,
        fetchModes: async () => [createMode("default")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.status).toBe("ready");
    });

    manager.refresh({ cwd: projectCwd, providers: [] });

    expect(manager.getSnapshot(projectCwd)).toEqual([
      {
        provider: "codex",
        status: "loading",
        label: "codex",
        description: "codex test provider",
        defaultModeId: null,
      },
      {
        provider: "claude",
        status: "loading",
        label: "claude",
        description: "claude test provider",
        defaultModeId: null,
      },
    ]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.models?.[0]?.id).toBe(
        "sonnet-4.5",
      );
    });

    expect(codexFetchModels).toHaveBeenCalledTimes(2);
    expect(claudeFetchModels).toHaveBeenCalledTimes(2);

    manager.destroy();
  });

  test("refresh ignores provider filters that are not in the registry", async () => {
    const codexFetchModels = vi
      .fn<() => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")]);
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: codexFetchModels,
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
    });

    manager.refresh({ cwd: projectCwd, providers: ["zai"] });

    expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")).toMatchObject({
      provider: "codex",
      status: "ready",
      models: [createModel("codex", "gpt-5.1")],
    });
    expect(codexFetchModels).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  test("refresh during an in-flight refresh is a no-op", async () => {
    const fetchModels = deferred<AgentModelDefinition[]>();
    const fetchModes = deferred<AgentMode[]>();
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => fetchModels.promise,
        fetchModes: async () => fetchModes.promise,
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());
    const changes: ProviderSnapshotEntry[][] = [];
    manager.on("change", (entries) => changes.push(entries));

    manager.refresh({ cwd: projectCwd });

    expect(manager.getSnapshot(projectCwd)).toEqual([
      {
        provider: "codex",
        status: "loading",
        label: "codex",
        description: "codex test provider",
        defaultModeId: null,
      },
    ]);

    manager.refresh({ cwd: projectCwd });
    manager.refresh({ cwd: projectCwd });
    manager.refresh({ cwd: projectCwd });

    expect(changes).toHaveLength(1);
    expect(handles.codex?.isAvailable).toHaveBeenCalledTimes(1);

    fetchModels.resolve([createModel("codex", "gpt-5.2")]);
    fetchModes.resolve([createMode("auto")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")).toMatchObject({
        provider: "codex",
        status: "ready",
        models: [createModel("codex", "gpt-5.2")],
        modes: [createMode("auto")],
      });
    });

    expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(1);
    expect(handles.codex?.fetchModes).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  test("getSnapshot returns stale ready entries and starts background warm-up when snapshot is older than TTL", async () => {
    let now = 1_000;
    const fetchModels = vi
      .fn<(cwd?: string) => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockResolvedValueOnce([createModel("codex", "gpt-5.2")]);
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async (cwd) => fetchModels(cwd),
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger(), {
      ttlMs,
      now: () => now,
    });

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
    });

    now += ttlMs + 1;

    const staleSnapshot = manager.getSnapshot(projectCwd);

    expect(getProviderEntry(staleSnapshot, "codex")).toMatchObject({
      provider: "codex",
      status: "ready",
      models: [createModel("codex", "gpt-5.1")],
      modes: [createMode("auto")],
    });

    await vi.waitFor(() => {
      expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    manager.destroy();
  });

  test("getSnapshot does not trigger a second warm-up while a stale re-warm is already in flight", async () => {
    let now = 2_000;
    const staleRefreshModels = deferred<AgentModelDefinition[]>();
    const fetchModels = vi
      .fn<(cwd?: string) => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockImplementationOnce(async () => staleRefreshModels.promise);
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async (cwd) => fetchModels(cwd),
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger(), {
      ttlMs,
      now: () => now,
    });

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
    });

    now += ttlMs + 1;

    const firstStaleSnapshot = manager.getSnapshot(projectCwd);
    const secondStaleSnapshot = manager.getSnapshot(projectCwd);

    expect(getProviderEntry(firstStaleSnapshot, "codex")?.models?.[0]?.id).toBe("gpt-5.1");
    expect(getProviderEntry(secondStaleSnapshot, "codex")?.models?.[0]?.id).toBe("gpt-5.1");

    await vi.waitFor(() => {
      expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(2);
    });

    staleRefreshModels.resolve([createModel("codex", "gpt-5.2")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(2);

    manager.destroy();
  });

  test("getSnapshot does not re-warm when the cached snapshot is still fresh", async () => {
    let now = 3_000;
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => [createModel("codex", "gpt-5.1")],
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger(), {
      ttlMs,
      now: () => now,
    });

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
    });

    now += ttlMs - 1;

    const freshSnapshot = manager.getSnapshot(projectCwd);

    expect(getProviderEntry(freshSnapshot, "codex")?.models?.[0]?.id).toBe("gpt-5.1");
    expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(1);

    manager.destroy();
  });

  test("getSnapshot re-warms snapshots in error and unavailable states after TTL", async () => {
    let now = 4_000;
    const unavailableFetchModels = vi
      .fn<(cwd?: string) => Promise<AgentModelDefinition[]>>()
      .mockResolvedValue([createModel("codex", "gpt-5.2")]);
    const unavailableIsAvailable = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const errorFetchModels = vi
      .fn<(cwd?: string) => Promise<AgentModelDefinition[]>>()
      .mockRejectedValueOnce(new Error("model lookup failed"))
      .mockResolvedValueOnce([createModel("claude", "sonnet")]);
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        isAvailable: unavailableIsAvailable,
        fetchModels: async (cwd) => unavailableFetchModels(cwd),
        fetchModes: async () => [createMode("auto")],
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: async (cwd) => errorFetchModels(cwd),
        fetchModes: async () => [createMode("default")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger(), {
      ttlMs,
      now: () => now,
    });

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe(
        "unavailable",
      );
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.status).toBe("error");
    });

    now += ttlMs + 1;

    const staleSnapshot = manager.getSnapshot(projectCwd);

    expect(getProviderEntry(staleSnapshot, "codex")?.status).toBe("unavailable");
    expect(getProviderEntry(staleSnapshot, "claude")?.status).toBe("error");

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.status).toBe("ready");
    });

    expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
      "gpt-5.2",
    );
    expect(getProviderEntry(manager.getSnapshot(projectCwd), "claude")?.models?.[0]?.id).toBe(
      "sonnet",
    );

    manager.destroy();
  });

  test("getSnapshot respects an injected TTL", async () => {
    let now = 5_000;
    const customTtlMs = 100;
    const fetchModels = vi
      .fn<(cwd?: string) => Promise<AgentModelDefinition[]>>()
      .mockResolvedValueOnce([createModel("codex", "gpt-5.1")])
      .mockResolvedValueOnce([createModel("codex", "gpt-5.2")]);
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async (cwd) => fetchModels(cwd),
        fetchModes: async () => [createMode("auto")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger(), {
      ttlMs: customTtlMs,
      now: () => now,
    });

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
    });

    now += customTtlMs - 1;
    manager.getSnapshot(projectCwd);
    expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(1);

    now += 2;
    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    manager.destroy();
  });

  test("multiple getSnapshot calls for same cwd do not trigger multiple warmUps", async () => {
    const codexModels = deferred<AgentModelDefinition[]>();
    const { registry, handles } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async () => codexModels.promise,
      }),
      createMockProvider({
        provider: "claude",
        fetchModels: async () => [],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);
    manager.getSnapshot(projectCwd);
    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(handles.codex?.isAvailable).toHaveBeenCalledTimes(1);
      expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(1);
      expect(handles.claude?.isAvailable).toHaveBeenCalledTimes(1);
      expect(handles.claude?.fetchModels).toHaveBeenCalledTimes(1);
    });

    codexModels.resolve([createModel("codex", "gpt-5.2")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "codex")?.status).toBe("ready");
    });

    manager.destroy();
  });

  test("different cwd keys get independent snapshots", async () => {
    const seenCwds: string[] = [];
    const { registry } = createRegistry([
      createMockProvider({
        provider: "codex",
        fetchModels: async (cwd) => {
          seenCwds.push(cwd ?? "__missing__");
          return [createModel("codex", `model:${cwd}`)];
        },
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectACwd);
    manager.getSnapshot(projectBCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectACwd), "codex")?.status).toBe("ready");
      expect(getProviderEntry(manager.getSnapshot(projectBCwd), "codex")?.status).toBe("ready");
    });

    expect(getProviderEntry(manager.getSnapshot(projectACwd), "codex")?.models?.[0]?.id).toBe(
      `model:${projectACwd}`,
    );
    expect(getProviderEntry(manager.getSnapshot(projectBCwd), "codex")?.models?.[0]?.id).toBe(
      `model:${projectBCwd}`,
    );
    expect(seenCwds).toEqual([projectACwd, projectBCwd]);

    manager.destroy();
  });

  test("snapshot includes user-defined providers from the registry", async () => {
    const { registry } = createRegistry([
      createMockProvider({ provider: "claude" }),
      createMockProvider({
        provider: "zai",
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "default",
        fetchModes: async () => [createMode("default")],
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    manager.getSnapshot(projectCwd);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "zai")?.status).toBe("ready");
    });

    expect(getProviderEntry(manager.getSnapshot(projectCwd), "zai")).toMatchObject({
      provider: "zai",
      status: "ready",
      label: "ZAI",
      description: "Custom Claude profile",
      defaultModeId: "default",
    });

    manager.destroy();
  });

  test("enabled false providers are omitted when absent from the registry", () => {
    const { registry } = createRegistry([createMockProvider({ provider: "claude" })]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    const snapshot = manager.getSnapshot(projectCwd);

    expect(snapshot.map((entry) => entry.provider)).toEqual(["claude"]);
    expect(getProviderEntry(snapshot, "zai")).toBeUndefined();

    manager.destroy();
  });

  test("snapshot entries include label and description from the registry", async () => {
    const models = deferred<AgentModelDefinition[]>();
    const modes = deferred<AgentMode[]>();
    const { registry } = createRegistry([
      createMockProvider({
        provider: "zai",
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "plan",
        fetchModels: async () => models.promise,
        fetchModes: async () => modes.promise,
      }),
    ]);
    const manager = new ProviderSnapshotManager(registry, createTestLogger());

    expect(manager.getSnapshot(projectCwd)).toEqual([
      {
        provider: "zai",
        status: "loading",
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "plan",
      },
    ]);

    models.resolve([createModel("zai", "zai-fast")]);
    modes.resolve([createMode("plan")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot(projectCwd), "zai")).toMatchObject({
        provider: "zai",
        status: "ready",
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "plan",
      });
    });

    manager.destroy();
  });
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRegistry(handles: MockProviderHandle[]): {
  registry: Record<AgentProvider, ProviderDefinition>;
  handles: Record<AgentProvider, MockProviderHandle>;
} {
  return {
    registry: Object.fromEntries(
      handles.map((handle) => [handle.definition.id, handle.definition]),
    ) as Record<AgentProvider, ProviderDefinition>,
    handles: Object.fromEntries(handles.map((handle) => [handle.definition.id, handle])) as Record<
      AgentProvider,
      MockProviderHandle
    >,
  };
}

function createMockProvider(options: MockProviderOptions): MockProviderHandle {
  const isAvailable = vi.fn(async () => options.isAvailable?.() ?? true);
  const fetchModels = vi.fn(
    async (listOptions?: { cwd?: string }) =>
      options.fetchModels?.(listOptions?.cwd) ?? [
        createModel(options.provider, `${options.provider}-default`),
      ],
  );
  const fetchModes = vi.fn(
    async (listOptions?: { cwd?: string }) =>
      options.fetchModes?.(listOptions?.cwd) ?? [createMode(`${options.provider}-mode`)],
  );

  const definition: ProviderDefinition = {
    id: options.provider,
    label: options.label ?? options.provider,
    description: options.description ?? `${options.provider} test provider`,
    defaultModeId: options.defaultModeId ?? null,
    modes: [],
    createClient: () =>
      ({
        provider: options.provider,
        capabilities: TEST_CAPABILITIES,
        async createSession() {
          throw new Error("not implemented");
        },
        async resumeSession() {
          throw new Error("not implemented");
        },
        async listModels() {
          return [];
        },
        async isAvailable() {
          return isAvailable();
        },
      }) satisfies AgentClient,
    fetchModels,
    fetchModes,
  };

  return {
    definition,
    isAvailable,
    fetchModels,
    fetchModes,
  };
}

function createModel(provider: AgentProvider, id: string): AgentModelDefinition {
  return {
    provider,
    id,
    label: id,
  };
}

function createMode(id: string): AgentMode {
  return {
    id,
    label: id,
  };
}

function getProviderEntry(
  entries: ProviderSnapshotEntry[],
  provider: AgentProvider,
): ProviderSnapshotEntry | undefined {
  return entries.find((entry) => entry.provider === provider);
}
