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

    const snapshot = manager.getSnapshot("/tmp/project");

    expect(snapshot).toEqual([
      { provider: "claude", status: "loading" },
      { provider: "codex", status: "loading" },
    ]);

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

    manager.getSnapshot("/tmp/project");

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "claude")?.status).toBe("ready");
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "codex")?.status).toBe("ready");
    });

    const snapshot = manager.getSnapshot("/tmp/project");
    expect(getProviderEntry(snapshot, "codex")).toMatchObject({
      provider: "codex",
      status: "ready",
      models: [createModel("codex", "gpt-5.2")],
      modes: [createMode("auto")],
    });
    expect(getProviderEntry(snapshot, "claude")).toMatchObject({
      provider: "claude",
      status: "ready",
      models: [createModel("claude", "sonnet")],
      modes: [createMode("default")],
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

    manager.getSnapshot("/tmp/project");

    await vi.waitFor(() => {
      expect(manager.getSnapshot("/tmp/project")).toEqual([
        { provider: "codex", status: "unavailable" },
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

    manager.getSnapshot("/tmp/project");

    await vi.waitFor(() => {
      expect(manager.getSnapshot("/tmp/project")).toEqual([
        {
          provider: "codex",
          status: "error",
          error: "model lookup failed",
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

    manager.getSnapshot("/tmp/project");

    claudeModels.resolve([createModel("claude", "sonnet")]);
    claudeModes.resolve([createMode("default")]);

    await vi.waitFor(() => {
      expect(changes).toHaveLength(1);
    });

    expect(changes[0]?.cwd).toBe("/tmp/project");
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

    manager.getSnapshot("/tmp/project");

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.1",
      );
    });

    manager.refresh("/tmp/project");
    expect(manager.getSnapshot("/tmp/project")).toEqual([{ provider: "codex", status: "loading" }]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "codex")?.models?.[0]?.id).toBe(
        "gpt-5.2",
      );
    });

    expect(codexFetchModels).toHaveBeenCalledTimes(2);

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

    manager.refresh("/tmp/project");

    expect(manager.getSnapshot("/tmp/project")).toEqual([{ provider: "codex", status: "loading" }]);

    manager.refresh("/tmp/project");
    manager.refresh("/tmp/project");
    manager.refresh("/tmp/project");

    expect(changes).toHaveLength(1);
    expect(handles.codex?.isAvailable).toHaveBeenCalledTimes(1);

    fetchModels.resolve([createModel("codex", "gpt-5.2")]);
    fetchModes.resolve([createMode("auto")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "codex")).toMatchObject({
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

    manager.getSnapshot("/tmp/project");
    manager.getSnapshot("/tmp/project");
    manager.getSnapshot("/tmp/project");

    await vi.waitFor(() => {
      expect(handles.codex?.isAvailable).toHaveBeenCalledTimes(1);
      expect(handles.codex?.fetchModels).toHaveBeenCalledTimes(1);
      expect(handles.claude?.isAvailable).toHaveBeenCalledTimes(1);
      expect(handles.claude?.fetchModels).toHaveBeenCalledTimes(1);
    });

    codexModels.resolve([createModel("codex", "gpt-5.2")]);

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project"), "codex")?.status).toBe("ready");
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

    manager.getSnapshot("/tmp/project-a");
    manager.getSnapshot("/tmp/project-b");

    await vi.waitFor(() => {
      expect(getProviderEntry(manager.getSnapshot("/tmp/project-a"), "codex")?.status).toBe(
        "ready",
      );
      expect(getProviderEntry(manager.getSnapshot("/tmp/project-b"), "codex")?.status).toBe(
        "ready",
      );
    });

    expect(getProviderEntry(manager.getSnapshot("/tmp/project-a"), "codex")?.models?.[0]?.id).toBe(
      "model:/tmp/project-a",
    );
    expect(getProviderEntry(manager.getSnapshot("/tmp/project-b"), "codex")?.models?.[0]?.id).toBe(
      "model:/tmp/project-b",
    );
    expect(seenCwds).toEqual(["/tmp/project-a", "/tmp/project-b"]);

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
    label: options.provider,
    description: `${options.provider} test provider`,
    defaultModeId: null,
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
