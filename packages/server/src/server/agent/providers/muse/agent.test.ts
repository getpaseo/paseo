import { describe, expect, test, vi } from "vitest";
import type { Logger } from "pino";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ProviderRefreshContext } from "../../agent-sdk-types.js";
import { buildProviderRegistry } from "../../provider-registry.js";
import {
  MUSE_DEFAULT_THINKING_OPTION_ID,
  MUSE_MODES,
  MUSE_THINKING_OPTIONS,
  MuseAgentClient,
  describeMuseAuthFileState,
  mapMuseCatalogEntry,
} from "./agent.js";
import type {
  MuseHostConnection,
  MuseHostSpawnOptions,
  MuseModelCatalogEntry,
} from "./host.js";

function createStubLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createCatalogEntry(
  overrides: Partial<MuseModelCatalogEntry> = {},
): MuseModelCatalogEntry {
  return {
    modelId: "muse-spark-1.2",
    displayLabel: "Muse Spark 1.2",
    description: "Meta coding model",
    isDefault: true,
    contextLimit: 1_000_000,
    ...overrides,
  };
}

function createFakeHost(entries: MuseModelCatalogEntry[] = [createCatalogEntry()]): {
  host: MuseHostConnection;
  spawner: ReturnType<typeof vi.fn>;
  spawns: MuseHostSpawnOptions[];
} {
  const host: MuseHostConnection = {
    initializeResult: {} as MuseHostConnection["initializeResult"],
    fingerprintWarning: undefined,
    command: vi.fn(async () => ({})),
    modelList: vi.fn(async () => ({
      models: entries,
      providerId: "meta",
      profileId: null,
      source: "bundledCatalog",
    })),
    onNotification: vi.fn(),
    onServerRequest: vi.fn(),
    onExit: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const spawns: MuseHostSpawnOptions[] = [];
  const spawner = vi.fn(async (options: MuseHostSpawnOptions) => {
    spawns.push(options);
    return host;
  });
  return { host, spawner, spawns };
}

function createRefreshContext(signal?: AbortSignal): ProviderRefreshContext {
  return {
    signal: signal ?? new AbortController().signal,
    runActivity: async (_name, operation) => operation(),
  };
}

describe("MuseAgentClient", () => {
  test("fetchCatalog maps models and returns static modes", async () => {
    const { host, spawner, spawns } = createFakeHost([
      createCatalogEntry(),
      createCatalogEntry({
        modelId: "muse-spark-1.1",
        displayLabel: "Muse Spark 1.1",
        isDefault: false,
        description: null,
        contextLimit: null,
      }),
    ]);
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const catalog = await client.fetchCatalog(
      { scope: "workspace", cwd: "/tmp/muse-catalog", force: false },
      createRefreshContext(),
    );

    expect(catalog.models).toEqual([
      {
        provider: "muse",
        id: "muse-spark-1.2",
        label: "Muse Spark 1.2",
        description: "Meta coding model",
        isDefault: true,
        contextWindowMaxTokens: 1_000_000,
        thinkingOptions: MUSE_THINKING_OPTIONS,
        defaultThinkingOptionId: MUSE_DEFAULT_THINKING_OPTION_ID,
      },
      {
        provider: "muse",
        id: "muse-spark-1.1",
        label: "Muse Spark 1.1",
        thinkingOptions: MUSE_THINKING_OPTIONS,
        defaultThinkingOptionId: MUSE_DEFAULT_THINKING_OPTION_ID,
      },
    ]);
    expect(catalog.modes).toEqual(MUSE_MODES);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe("muse");
    expect(spawns[0]?.args).toEqual(["serve", "--trust-workspace"]);
    expect(spawns[0]?.cwd).toBe("/tmp/muse-catalog");
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  test("fetchCatalog tolerates an empty catalog", async () => {
    const { spawner } = createFakeHost([]);
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const catalog = await client.fetchCatalog(
      { scope: "global", force: true },
      createRefreshContext(),
    );

    expect(catalog.models).toEqual([]);
    expect(catalog.modes).toEqual(MUSE_MODES);
  });

  test("fetchCatalog skips malformed rows and warns", async () => {
    const logger = createStubLogger();
    const { spawner } = createFakeHost([
      createCatalogEntry(),
      { displayLabel: "Missing id" } as MuseModelCatalogEntry,
    ]);
    const client = new MuseAgentClient({ logger, hostSpawner: spawner });

    const catalog = await client.fetchCatalog(
      { scope: "global", force: false },
      createRefreshContext(),
    );

    expect(catalog.models.map((model) => model.id)).toEqual(["muse-spark-1.2"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("fetchCatalog warns on schema fingerprint drift without failing", async () => {
    const logger = createStubLogger();
    const { host, spawner } = createFakeHost();
    host.fingerprintWarning = {
      kind: "schemaFingerprintMismatch",
      pinned: "sha256:pinned",
      served: "sha256:served",
      message: "fingerprint moved",
    };
    const client = new MuseAgentClient({ logger, hostSpawner: spawner });

    const catalog = await client.fetchCatalog(
      { scope: "global", force: false },
      createRefreshContext(),
    );

    expect(catalog.models).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { pinned: "sha256:pinned", served: "sha256:served" },
      "fingerprint moved",
    );
  });

  test("fetchCatalog attaches the host stderr tail when spawn fails", async () => {
    const spawner = vi.fn(async (options: MuseHostSpawnOptions) => {
      options.onStderr?.("compose serve model client: failed to read auth file\n");
      throw new Error("connection reached EOF");
    });
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const failure = await client
      .fetchCatalog({ scope: "global", force: false }, createRefreshContext())
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("connection reached EOF");
    expect((failure as Error).message).toContain("failed to read auth file");
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  test("fetchCatalog closes the host when the refresh is aborted", async () => {
    const { host, spawner } = createFakeHost();
    const controller = new AbortController();
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const pending = client.fetchCatalog(
      { scope: "global", force: false },
      createRefreshContext(controller.signal),
    );
    controller.abort();
    await pending;

    expect(host.close).toHaveBeenCalled();
  });

  test("isAvailable is false when the binary cannot be resolved", async () => {
    const client = new MuseAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { command: { mode: "replace", argv: ["definitely-not-a-muse-binary"] } },
    });

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("getDiagnostic reports launch and credential state", async () => {
    const client = new MuseAgentClient({ logger: createTestLogger() });

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Muse");
    expect(diagnostic).toContain("META_API_KEY");
    expect(diagnostic).toContain("auth.json");
  });

  test("createSession starts an MSP session with mode, model, and MCP servers", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    let host!: MuseHostConnection;
    host = {
      initializeResult: {} as MuseHostConnection["initializeResult"],
      fingerprintWarning: undefined,
      command: vi.fn(async (method: string, params: Record<string, unknown>) => {
        commands.push({ method, params });
        return {
          session: {
            sessionId: "msp-session-1",
            modelId: "muse-spark-1.2",
            approvalMode: { mode: "allowAll" },
          },
        };
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const spawner = vi.fn(async () => host);
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const session = await client.createSession({
      provider: "muse",
      cwd: "/tmp/muse",
      model: "muse-spark-1.2",
      modeId: "allowAll",
      systemPrompt: "Be terse.",
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:1/mcp/agents" },
      },
    });

    expect(session.id).toBe("msp-session-1");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      method: "session/start",
      params: {
        workspaceRoot: "/tmp/muse",
        approvalMode: "allowAll",
        modelId: "muse-spark-1.2",
        config: {
          mcpServers: {
            paseo: { transport: "streamableHttp", url: "http://127.0.0.1:1/mcp/agents" },
          },
        },
      },
    });
    await expect(session.getCurrentMode()).resolves.toBe("allowAll");
    await session.close();
  });

  test("createSession rejects unknown modes without spawning", async () => {
    const spawner = vi.fn(async () => {
      throw new Error("must not spawn");
    });
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    await expect(
      client.createSession({ provider: "muse", cwd: "/tmp/muse", modeId: "yolo" }),
    ).rejects.toThrow("Unknown Muse approval mode: yolo");
    expect(spawner).not.toHaveBeenCalled();
  });

  test("createSession closes the host when session/start fails", async () => {
    const close = vi.fn(async () => {});
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async () => {
        throw new Error("start blew up");
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close,
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    await expect(
      client.createSession({ provider: "muse", cwd: "/tmp/muse" }),
    ).rejects.toThrow("start blew up");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("resumeSession resumes by native handle and merges overrides", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async (method: string, params: Record<string, unknown>) => {
        commands.push({ method, params });
        return {
          session: {
            sessionId: "msp-session-9",
            modelId: "muse-spark-1.2",
            approvalMode: { mode: "promptUnmatched" },
          },
          history: { mode: "inline", items: [] },
          pendingRequests: [],
          viewCursor: "v:head",
        };
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close: vi.fn(async () => {}),
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const session = await client.resumeSession(
      {
        provider: "muse",
        sessionId: "msp-session-9",
        nativeHandle: "msp-session-9",
        metadata: { cwd: "/tmp/muse-old", model: "muse-spark-1.1" },
      },
      { cwd: "/tmp/muse-new" },
    );

    expect(session.id).toBe("msp-session-9");
    expect(commands).toEqual([
      { method: "session/resume", params: { sessionId: "msp-session-9" } },
    ]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      provider: "muse",
      sessionId: "msp-session-9",
      model: "muse-spark-1.1",
      modeId: "promptUnmatched",
    });
    expect(session.describePersistence()).toMatchObject({
      provider: "muse",
      sessionId: "msp-session-9",
      nativeHandle: "msp-session-9",
    });
    await session.close();
  });

  test("listImportableSessions pages, filters by cwd, and sorts newest first", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const close = vi.fn(async () => {});
    const spawns: MuseHostSpawnOptions[] = [];
    const spawner = vi.fn(async (options: MuseHostSpawnOptions) => {
      spawns.push(options);
      return {
        initializeResult: {},
        fingerprintWarning: undefined,
        command: vi.fn(async (method: string, params: Record<string, unknown>) => {
          commands.push({ method, params });
          if (params["cursor"] === "c1") {
            return {
              sessions: [
                {
                  sessionId: "msp-c",
                  workspaceRoot: "/tmp/ws",
                  title: "newest",
                  updatedAt: "2026-09-14T12:00:00.000Z",
                },
              ],
            };
          }
          return {
            sessions: [
              {
                sessionId: "msp-a",
                workspaceRoot: "/tmp/ws",
                title: "older",
                updatedAt: "2026-09-14T10:00:00.000Z",
              },
              {
                sessionId: "msp-b",
                workspaceRoot: "/tmp/other",
                title: "elsewhere",
                updatedAt: "2026-09-14T11:00:00.000Z",
              },
              { workspaceRoot: "/tmp/ws", title: "missing id" },
            ],
            nextCursor: "c1",
          };
        }),
        modelList: vi.fn(async () => ({ models: [] })),
        onNotification: vi.fn(),
        onServerRequest: vi.fn(),
        onExit: vi.fn(),
        close,
      };
    });
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const rows = await client.listImportableSessions({ cwd: "/tmp/ws" });

    expect(rows).toEqual([
      {
        providerHandleId: "msp-c",
        cwd: "/tmp/ws",
        title: "newest",
        firstPromptPreview: null,
        lastPromptPreview: null,
        lastActivityAt: new Date("2026-09-14T12:00:00.000Z"),
      },
      {
        providerHandleId: "msp-a",
        cwd: "/tmp/ws",
        title: "older",
        firstPromptPreview: null,
        lastPromptPreview: null,
        lastActivityAt: new Date("2026-09-14T10:00:00.000Z"),
      },
    ]);
    expect(commands.map((command) => command.params["cursor"] ?? null)).toEqual([null, "c1"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cwd).toBe("/tmp/ws");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("listImportableSessions honors limit and survives cursor loops", async () => {
    let calls = 0;
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async () => {
        calls += 1;
        return {
          sessions: [
            {
              sessionId: `msp-${calls}`,
              workspaceRoot: "/tmp/ws",
              title: "  ",
              updatedAt: "not a date",
            },
          ],
          nextCursor: "loop",
        };
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close: vi.fn(async () => {}),
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const rows = await client.listImportableSessions({ limit: 5 });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ providerHandleId: "msp-1", title: null });
    expect(rows[0]?.lastActivityAt).toEqual(new Date(0));
    expect(calls).toBe(2);
  });

  test("listImportableSessions closes the host on failure", async () => {
    const close = vi.fn(async () => {});
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async () => {
        throw new Error("list blew up");
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close,
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    await expect(client.listImportableSessions()).rejects.toThrow("list blew up");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("importSession resumes the native session and collects history", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async (method: string, params: Record<string, unknown>) => {
        commands.push({ method, params });
        return {
          session: {
            sessionId: "msp-1",
            modelId: "muse-spark-1.2",
            approvalMode: { mode: "onRequest" },
          },
          history: {
            mode: "inline",
            items: [
              {
                itemId: "u1",
                revision: 1,
                kind: "userMessage",
                turnId: "t0",
                status: "completed",
                text: "past",
              },
              {
                itemId: "a1",
                revision: 1,
                kind: "agentMessage",
                turnId: "t0",
                status: "completed",
                text: "reply",
              },
            ],
          },
        };
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close: vi.fn(async () => {}),
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const imported = await client.importSession(
      { providerHandleId: "msp-1", cwd: "/tmp/ws" },
      {
        config: { provider: "muse", cwd: "/tmp/ws" },
        storedConfig: { provider: "muse", cwd: "/tmp/ws" },
      },
    );

    expect(imported.session.id).toBe("msp-1");
    expect(imported.persistence).toMatchObject({
      provider: "muse",
      sessionId: "msp-1",
      nativeHandle: "msp-1",
    });
    expect(imported.timeline).toHaveLength(2);
    expect(imported.timeline[0]?.item).toMatchObject({ type: "user_message", text: "past" });
    expect(commands.map((command) => command.method)).toEqual([
      "session/resume",
      "session/resume",
    ]);
    await imported.session.close();
  });

  test("createSession applies thinkingOptionId via setReasoningEffort", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawner = vi.fn(async () => ({
      initializeResult: {},
      fingerprintWarning: undefined,
      command: vi.fn(async (method: string, params: Record<string, unknown>) => {
        commands.push({ method, params });
        return {
          session: {
            sessionId: "msp-session-1",
            modelId: "muse-spark-1.2",
            approvalMode: { mode: "allowAll" },
          },
        };
      }),
      modelList: vi.fn(async () => ({ models: [] })),
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onExit: vi.fn(),
      close: vi.fn(async () => {}),
    }));
    const client = new MuseAgentClient({ logger: createTestLogger(), hostSpawner: spawner });

    const session = await client.createSession({
      provider: "muse",
      cwd: "/tmp/muse",
      thinkingOptionId: "low",
    });

    expect(commands).toEqual([
      {
        method: "session/start",
        params: { workspaceRoot: "/tmp/muse", approvalMode: "onRequest" },
      },
      {
        method: "session/setReasoningEffort",
        params: { sessionId: "msp-session-1", reasoningEffort: "low" },
      },
    ]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      thinkingOptionId: "low",
    });
    await session.close();

    await expect(
      client.createSession({ provider: "muse", cwd: "/tmp/muse", thinkingOptionId: "bogus" }),
    ).rejects.toThrow("Unknown Muse thinking option: bogus");
  });

  test("registry exposes the muse provider", () => {
    const registry = buildProviderRegistry(createTestLogger());

    expect(registry.muse.id).toBe("muse");
    expect(registry.muse.enabled).toBe(false);
    const client = registry.muse.createClient(createTestLogger());
    expect(client.provider).toBe("muse");
  });
});

describe("describeMuseAuthFileState", () => {
  test("distinguishes found, missing, and unreadable", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "muse-auth-"));
    const present = join(dir, "auth.json");
    await writeFile(present, "{}");

    expect(describeMuseAuthFileState(present)).toBe("found");
    expect(describeMuseAuthFileState(join(dir, "missing.json"))).toBe("not found");
    expect(
      describeMuseAuthFileState(present, () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).toBe("present but unreadable");
    expect(
      describeMuseAuthFileState(present, () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    ).toBe("not found");
  });
});

describe("mapMuseCatalogEntry", () => {
  test("returns null for rows without an id or label", () => {
    expect(mapMuseCatalogEntry({} as MuseModelCatalogEntry)).toBeNull();
    expect(mapMuseCatalogEntry({ modelId: "x" } as MuseModelCatalogEntry)).toBeNull();
  });
});
