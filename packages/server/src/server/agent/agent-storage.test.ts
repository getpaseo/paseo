import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveTurnBehavior, QueuedAgentMessage } from "@getpaseo/protocol/messages";
import { AgentMessageQueue, summarizeQueuedAgentMessages } from "./message-queue.js";
import { AgentManager } from "./agent-manager.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, logger);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.list();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, logger);
    const before = await reloaded.list();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, logger);
    const after = await afterReload.list();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});

describe("durable message queue", () => {
  let directory: string;
  let storage: AgentStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "paseo-message-queue-"));
    storage = new AgentStorage(directory, createTestLogger());
    await storage.initialize();
    await storage.upsert({
      id: "agent",
      provider: "codex",
      cwd: directory,
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
      labels: {},
      lastStatus: "idle",
      config: null,
    });
  });

  afterEach(async () => {
    await storage.flush();
    await rm(directory, { recursive: true, force: true });
  });

  function fixture(dispatch?: (message: QueuedAgentMessage) => Promise<void>) {
    const state = { idle: false };
    const sent: Array<{ message: QueuedAgentMessage; behavior: ActiveTurnBehavior }> = [];
    const errors: unknown[] = [];
    const published: QueuedAgentMessage[][] = [];
    const queue = new AgentMessageQueue({
      storage,
      isIdle: () => state.idle,
      dispatch: async (_agentId, message, behavior) => {
        sent.push({ message, behavior });
        state.idle = false;
        await dispatch?.(message);
        return true;
      },
      publish: async (agentId) => {
        published.push((await storage.get(agentId))?.queuedMessages ?? []);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    return { queue, state, sent, errors, published };
  }

  test("queued text, images, attachments and mode survive a new daemon storage instance", async () => {
    const { queue } = fixture();
    const message = await queue.enqueue({
      agentId: "agent",
      messageId: "first",
      text: "Next task",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      attachments: [
        {
          type: "uploaded_file",
          id: "file",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          path: "/tmp/notes.txt",
        },
      ],
      sessionMode: "plan",
    });
    await queue.flush();
    queue.stop();
    const recovered = new AgentStorage(directory, createTestLogger());
    await recovered.initialize();
    expect((await recovered.get("agent"))?.queuedMessages).toEqual([message]);
  });

  test("each successful completion drains one FIFO message without any client", async () => {
    const { queue, state, sent } = fixture();
    await queue.enqueue({ agentId: "agent", messageId: "first", text: "one" });
    await queue.enqueue({ agentId: "agent", messageId: "second", text: "two" });
    await queue.flush();
    expect(sent).toEqual([]);
    state.idle = true;
    queue.drain("agent");
    queue.drain("agent");
    await queue.flush();
    expect(sent.map((entry) => entry.message.id)).toEqual(["first"]);
    expect((await queue.list("agent")).map((message) => message.id)).toEqual(["second"]);
    state.idle = true;
    queue.drain("agent");
    await queue.flush();
    expect(sent.map((entry) => entry.message.id)).toEqual(["first", "second"]);
    expect(sent.map((entry) => entry.behavior)).toEqual(["steer", "steer"]);
    expect(await queue.list("agent")).toEqual([]);
  });

  test("enqueue arriving after a turn finished dispatches immediately and deduplicates retries after delivery", async () => {
    const { queue, state, sent } = fixture();
    state.idle = true;
    const original = await queue.enqueue({ agentId: "agent", messageId: "same", text: "one" });
    await queue.flush();
    const repeated = await queue.enqueue({ agentId: "agent", messageId: "same", text: "one" });
    await queue.flush();
    expect(repeated).toEqual(original);
    expect(sent).toHaveLength(1);
    await expect(
      queue.enqueue({ agentId: "agent", messageId: "same", text: "different" }),
    ).rejects.toThrow("agent_request_key_conflict");
    await queue.enqueue({ agentId: "agent", messageId: "new", text: "new" });
    expect((await queue.list("agent")).map((message) => message.id)).toEqual(["new"]);
  });

  test("editing removes the selected message atomically and send now honors interruption", async () => {
    const { queue, sent } = fixture();
    const first = await queue.enqueue({ agentId: "agent", messageId: "first", text: "one" });
    await queue.enqueue({ agentId: "agent", messageId: "second", text: "two" });
    await queue.flush();
    expect(await queue.remove("agent", "first")).toEqual(first);
    expect(await queue.remove("agent", "first")).toBeNull();
    await queue.sendNow("agent", "second", "interrupt");
    expect(sent.map((entry) => ({ id: entry.message.id, behavior: entry.behavior }))).toEqual([
      { id: "second", behavior: "interrupt" },
    ]);
    expect(await queue.list("agent")).toEqual([]);
  });

  test("failed dispatch retains an error and prevents automatic retry", async () => {
    const { queue, state, sent, errors } = fixture(async () => {
      throw new Error("Provider unavailable");
    });
    await queue.enqueue({ agentId: "agent", messageId: "first", text: "one" });
    await queue.flush();
    state.idle = true;
    queue.drain("agent");
    await queue.flush();
    expect((await queue.list("agent"))[0]?.error).toBe("Provider unavailable");
    expect(errors).toHaveLength(1);
    state.idle = true;
    queue.drain("agent");
    await queue.flush();
    expect(sent).toHaveLength(1);
  });

  test("a crash during dispatch retains the prompt with an explicit uncertain outcome", async () => {
    const { queue } = fixture();
    await queue.enqueue({ agentId: "agent", messageId: "first", text: "one" });
    await queue.flush();
    await storage.claimQueuedAgentMessage("agent", "first");
    const recovered = new AgentStorage(directory, createTestLogger());
    await recovered.initialize();
    expect((await recovered.get("agent"))?.queuedMessages).toMatchObject([
      {
        id: "first",
        error: "Delivery was interrupted. Check the conversation before sending again.",
      },
    ]);
    expect((await recovered.get("agent"))?.dispatchingQueuedMessageId).toBeUndefined();
  });

  test("stale agent snapshots preserve queue mutations and shutdown leaves pending work", async () => {
    const { queue, state, sent } = fixture();
    const stale = await storage.get("agent");
    expect(stale).not.toBeNull();
    const message = await queue.enqueue({ agentId: "agent", messageId: "first", text: "one" });
    if (!stale) throw new Error("Missing agent fixture");
    await storage.upsert(stale);
    expect(await queue.list("agent")).toEqual([message]);
    queue.stop();
    state.idle = true;
    queue.drain("agent");
    await queue.flush();
    expect(sent).toEqual([]);
    expect(await queue.list("agent")).toEqual([message]);
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  test("AgentManager sends the next persisted message after completion with no connected app", async () => {
    const firstFinished = deferred();
    const nextStarted = deferred();
    const nextFinished = deferred();
    const prompts: string[] = [];
    const client = createTestAgentClient("codex", {
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
        if (prompts.length === 2) nextStarted.resolve();
      },
      beforeTurnComplete: async () => {
        await (prompts.length === 1 ? firstFinished.promise : nextFinished.promise);
      },
    });
    const manager = new AgentManager({
      registry: storage,
      clients: { codex: client },
      logger: createTestLogger(),
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
      workspaceId: undefined,
    });
    try {
      await sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        prompt: "first task",
        logger: createTestLogger(),
      });
      await waitForAgentRunStartWithTimeout(manager, agent.id);
      if (!manager.messageQueue) throw new Error("Missing message queue");
      await manager.messageQueue.enqueue({
        agentId: agent.id,
        messageId: "next",
        text: "second task",
      });
      await manager.messageQueue.flush();
      expect(prompts).toHaveLength(1);
      firstFinished.resolve();
      await nextStarted.promise;
      await manager.messageQueue.flush();
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("second task");
      expect(await manager.messageQueue.list(agent.id)).toEqual([]);
    } finally {
      firstFinished.resolve();
      nextFinished.resolve();
      manager.prepareForShutdown();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  test("AgentManager Stop holds queued follow-ups instead of starting another turn", async () => {
    const finish = deferred();
    const prompts: string[] = [];
    const client = createTestAgentClient("codex", {
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
      },
      beforeTurnComplete: async () => {
        await finish.promise;
      },
    });
    const manager = new AgentManager({
      registry: storage,
      clients: { codex: client },
      logger: createTestLogger(),
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
      workspaceId: undefined,
    });
    try {
      await sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        prompt: "first task",
        logger: createTestLogger(),
      });
      await waitForAgentRunStartWithTimeout(manager, agent.id);
      if (!manager.messageQueue) throw new Error("Missing message queue");
      await manager.messageQueue.enqueue({
        agentId: agent.id,
        messageId: "next",
        text: "second task",
      });
      await manager.messageQueue.flush();
      await manager.cancelAgentRun(agent.id);
      await manager.messageQueue.flush();
      expect(prompts).toHaveLength(1);
      expect((await manager.messageQueue.list(agent.id)).map((message) => message.id)).toEqual([
        "next",
      ]);
    } finally {
      manager.prepareForShutdown();
      finish.resolve();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  test("Stop holds the queue when interruption synchronously reports successful completion", async () => {
    const finish = deferred();
    const prompts: string[] = [];
    const client = createTestAgentClient("codex", {
      completeOnInterrupt: true,
      onStartTurn: (prompt) => {
        prompts.push(String(prompt));
      },
      beforeTurnComplete: async () => {
        await finish.promise;
      },
    });
    const manager = new AgentManager({
      registry: storage,
      clients: { codex: client },
      logger: createTestLogger(),
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
      workspaceId: undefined,
    });
    try {
      await sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        prompt: "first task",
        logger: createTestLogger(),
      });
      await waitForAgentRunStartWithTimeout(manager, agent.id);
      const queue = manager.messageQueue;
      if (!queue) throw new Error("Missing queue");
      await queue.enqueue({ agentId: agent.id, messageId: "next", text: "second task" });
      await queue.flush();
      await manager.cancelAgentRun(agent.id);
      await queue.flush();
      expect(prompts).toHaveLength(1);
      expect((await queue.list(agent.id)).map((message) => message.id)).toEqual(["next"]);
    } finally {
      manager.prepareForShutdown();
      finish.resolve();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  class HeldMessageStorage extends AgentStorage {
    readonly admitted = deferred();
    readonly claimed = deferred();
    admissionGate?: Promise<void>;
    claimGate?: Promise<void>;

    override async enqueueAgentMessage(
      agentId: string,
      message: QueuedAgentMessage,
    ): Promise<QueuedAgentMessage> {
      const result = await super.enqueueAgentMessage(agentId, message);
      this.admitted.resolve();
      await this.admissionGate;
      return result;
    }

    override async claimQueuedAgentMessage(
      agentId: string,
      messageId: string,
    ): Promise<QueuedAgentMessage | null> {
      const result = await super.claimQueuedAgentMessage(agentId, messageId);
      this.claimed.resolve();
      await this.claimGate;
      return result;
    }
  }

  async function heldManager() {
    const held = new HeldMessageStorage(directory, createTestLogger());
    await held.initialize();
    storage = held;
    const prompts: string[] = [];
    const manager = new AgentManager({
      registry: held,
      logger: createTestLogger(),
      clients: {
        codex: createTestAgentClient("codex", {
          onStartTurn: (prompt) => {
            prompts.push(String(prompt));
          },
        }),
      },
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
      workspaceId: undefined,
    });
    const queue = manager.messageQueue;
    if (!queue) throw new Error("Missing queue");
    return { held, prompts, manager, agent, queue };
  }

  test("Stop overtakes a persisted enqueue before its admission acknowledgment", async () => {
    const { held, prompts, manager, agent, queue } = await heldManager();
    const resume = deferred();
    held.admissionGate = resume.promise;
    try {
      const enqueue = queue.enqueue({ agentId: agent.id, messageId: "next", text: "second task" });
      await held.admitted.promise;
      await manager.cancelAgentRun(agent.id);
      resume.resolve();
      await enqueue;
      await queue.flush();
      expect(prompts).toEqual([]);
      expect(await queue.list(agent.id)).toMatchObject([{ id: "next" }]);
    } finally {
      resume.resolve();
      manager.prepareForShutdown();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  test("Stop overtakes a durable dispatch claim and releases it without losing the prompt", async () => {
    const { held, prompts, manager, agent, queue } = await heldManager();
    const resume = deferred();
    held.claimGate = resume.promise;
    try {
      await queue.enqueue({ agentId: agent.id, messageId: "next", text: "second task" });
      await held.claimed.promise;
      await manager.cancelAgentRun(agent.id);
      resume.resolve();
      await queue.flush();
      expect(prompts).toEqual([]);
      expect(await queue.list(agent.id)).toMatchObject([{ id: "next" }]);
      expect((await held.get(agent.id))?.dispatchingQueuedMessageId).toBeUndefined();
    } finally {
      resume.resolve();
      manager.prepareForShutdown();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  test("archive overtakes a durable claim without reviving the agent or consuming queued work", async () => {
    const { held, prompts, manager, agent, queue } = await heldManager();
    const resume = deferred();
    held.claimGate = resume.promise;
    try {
      await queue.enqueue({ agentId: agent.id, messageId: "next", text: "second task" });
      await held.claimed.promise;
      await manager.archiveAgent(agent.id);
      resume.resolve();
      await queue.flush();
      expect(prompts).toEqual([]);
      expect(manager.getAgent(agent.id)).toBeNull();
      expect((await held.get(agent.id))?.archivedAt).toBeTruthy();
      expect(await queue.list(agent.id)).toMatchObject([{ id: "next" }]);
      expect((await held.get(agent.id))?.dispatchingQueuedMessageId).toBeUndefined();
    } finally {
      resume.resolve();
      manager.prepareForShutdown();
      await manager.closeAgent(agent.id);
      await manager.flushForShutdown();
    }
  });

  test("queue summaries bound text previews and omit full attachment bytes", () => {
    const summaries = summarizeQueuedAgentMessages([
      {
        id: "large",
        text: "x".repeat(3_000_000),
        images: [{ data: "a".repeat(8_000_000), mimeType: "image/png" }],
        attachments: [{ type: "text", mimeType: "text/plain", text: "b".repeat(3_000_000) }],
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]);
    expect(summaries).toEqual([
      {
        id: "large",
        text: "x".repeat(2000),
        attachmentCount: 2,
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(summaries).length).toBeLessThan(2200);
  });
});
