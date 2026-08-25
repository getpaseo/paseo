import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

async function registryTreeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relative = ""): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const childRelative = path.join(relative, child.name);
      const childPath = path.join(directory, child.name);
      hash.update(`${child.isDirectory() ? "d" : "f"}\u0000${childRelative}\u0000`);
      if (child.isDirectory()) {
        await visit(childPath, childRelative);
      } else {
        hash.update(await fs.readFile(childPath));
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
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

function persistedRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "codex",
    cwd: `/tmp/${id}`,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    lastStatus: "idle",
    ...overrides,
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
    vi.restoreAllMocks();
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

  test("inventoryState reports malformed persisted records instead of silently omitting them", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "broken.json"), "{not json", "utf8");

    await storage.initialize();

    expect(storage.inventoryState()).toEqual({
      records: [],
      issues: [{ path: path.join(projectDir, "broken.json"), reason: "malformed_record" }],
    });
  });

  test("inventoryState reports duplicate persisted agent identities", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "duplicate-agent", cwd: "/tmp/project-a" }),
    );
    const stored = await storage.get("duplicate-agent");
    expect(stored).not.toBeNull();

    const projectDir = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "duplicate-agent.json"),
      JSON.stringify({ ...stored, cwd: "/tmp/project-b" }),
      "utf8",
    );

    const reloaded = new AgentStorage(storagePath, logger);
    await reloaded.initialize();
    expect(reloaded.inventoryState().issues).toEqual(
      expect.arrayContaining([
        { path: expect.any(String), reason: "duplicate_agent_id" },
        { path: expect.any(String), reason: "duplicate_agent_id" },
      ]),
    );
  });

  test("inventoryState reports an unreadable root but tolerates an absent root", async () => {
    await fs.writeFile(storagePath, "not a directory", "utf8");
    const unreadable = new AgentStorage(storagePath, logger);
    await unreadable.initialize();
    expect(unreadable.inventoryState().issues).toEqual([
      { path: storagePath, reason: "unreadable_path" },
    ]);

    const absent = new AgentStorage(path.join(tmpDir, "does-not-exist"), logger);
    await absent.initialize();
    expect(absent.inventoryState()).toEqual({ records: [], issues: [] });
  });

  test("inventoryState reports an unreadable nested registry path", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    await fs.mkdir(projectDir, { recursive: true });
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === projectDir) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realReaddir(...args);
    });

    await storage.initialize();

    expect(storage.inventoryState().issues).toContainEqual({
      path: projectDir,
      reason: "unreadable_path",
    });
  });

  test("inventoryState reports an unreadable record without modifying it", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    const recordPath = path.join(projectDir, "unreadable.json");
    await fs.mkdir(projectDir, { recursive: true });
    const original = JSON.stringify({ invalid: true });
    await fs.writeFile(recordPath, original, "utf8");
    const realReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === recordPath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realReadFile(...args);
    });

    await storage.initialize();

    expect(storage.inventoryState().issues).toContainEqual({
      path: recordPath,
      reason: "unreadable_path",
    });
    vi.restoreAllMocks();
    expect(await fs.readFile(recordPath, "utf8")).toBe(original);
  });

  test("inventoryState is read-only and preserves the registry tree hash", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "read-only-agent" }));
    const before = await registryTreeHash(storagePath);

    await storage.initialize();
    storage.inventoryState();

    expect(await registryTreeHash(storagePath)).toBe(before);
  });

  test.skipIf(process.platform === "win32")(
    "inventoryState fails closed on a root-level symlink to a JSON record",
    async () => {
      await fs.mkdir(storagePath, { recursive: true });
      const targetRecord = {
        id: "symlinked-root-agent",
        provider: "claude",
        cwd: "/tmp/project",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      const targetPath = path.join(tmpDir, "symlink-target.json");
      await fs.writeFile(targetPath, JSON.stringify(targetRecord), "utf8");
      const linkPath = path.join(storagePath, "root-link.json");
      await fs.symlink(targetPath, linkPath);

      const reloaded = new AgentStorage(storagePath, logger);
      await reloaded.initialize();

      expect(reloaded.inventoryState().records).toHaveLength(0);
      expect(reloaded.inventoryState().issues).toContainEqual({
        path: linkPath,
        reason: "unreadable_path",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "inventoryState fails closed on a symlinked project directory",
    async () => {
      await fs.mkdir(storagePath, { recursive: true });
      const realProjectDir = path.join(tmpDir, "real-project");
      await fs.mkdir(realProjectDir, { recursive: true });
      await fs.writeFile(
        path.join(realProjectDir, "agent-1.json"),
        JSON.stringify({
          id: "agent-in-symlinked-dir",
          provider: "claude",
          cwd: "/tmp/project",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
        "utf8",
      );
      const linkPath = path.join(storagePath, "project-link");
      await fs.symlink(realProjectDir, linkPath, "dir");

      const reloaded = new AgentStorage(storagePath, logger);
      await reloaded.initialize();

      expect(reloaded.inventoryState().records).toHaveLength(0);
      expect(reloaded.inventoryState().issues).toContainEqual({
        path: linkPath,
        reason: "unreadable_path",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "inventoryState fails closed on a symlink inside a project directory",
    async () => {
      const projectDir = path.join(storagePath, "tmp-project");
      await fs.mkdir(projectDir, { recursive: true });
      const targetPath = path.join(tmpDir, "outside.json");
      await fs.writeFile(
        targetPath,
        JSON.stringify({
          id: "symlinked-inside-agent",
          provider: "claude",
          cwd: "/tmp/project",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
        "utf8",
      );
      const linkPath = path.join(projectDir, "agent-link.json");
      await fs.symlink(targetPath, linkPath);

      const reloaded = new AgentStorage(storagePath, logger);
      await reloaded.initialize();

      expect(reloaded.inventoryState().records).toHaveLength(0);
      expect(reloaded.inventoryState().issues).toContainEqual({
        path: linkPath,
        reason: "unreadable_path",
      });
    },
  );

  test("inventoryState fails closed on a nested directory inside a project directory", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    const nestedDir = path.join(projectDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });

    const reloaded = new AgentStorage(storagePath, logger);
    await reloaded.initialize();

    expect(reloaded.inventoryState().records).toHaveLength(0);
    expect(reloaded.inventoryState().issues).toContainEqual({
      path: nestedDir,
      reason: "unreadable_path",
    });
  });

  test("inventoryState reports unexpected regular files", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    await fs.mkdir(projectDir, { recursive: true });
    const rootUnexpected = path.join(storagePath, "notes.txt");
    const projectUnexpected = path.join(projectDir, "notes.txt");
    await fs.writeFile(rootUnexpected, "not a record", "utf8");
    await fs.writeFile(projectUnexpected, "not a record", "utf8");

    const reloaded = new AgentStorage(storagePath, logger);
    await reloaded.initialize();

    expect(reloaded.inventoryState().records).toHaveLength(0);
    expect(reloaded.inventoryState().issues).toContainEqual({
      path: rootUnexpected,
      reason: "unreadable_path",
    });
    expect(reloaded.inventoryState().issues).toContainEqual({
      path: projectUnexpected,
      reason: "unreadable_path",
    });
  });

  test("inventoryState loads root-level and project JSON records", async () => {
    await fs.mkdir(storagePath, { recursive: true });
    const rootRecord = {
      id: "root-agent",
      provider: "claude",
      cwd: "/tmp/project-a",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(storagePath, "root-agent.json"),
      JSON.stringify(rootRecord),
      "utf8",
    );

    const projectDir = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDir, { recursive: true });
    const projectRecord = {
      id: "project-agent",
      provider: "codex",
      cwd: "/tmp/project-b",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(projectDir, "project-agent.json"),
      JSON.stringify(projectRecord),
      "utf8",
    );

    const reloaded = new AgentStorage(storagePath, logger);
    await reloaded.initialize();

    const ids = reloaded
      .inventoryState()
      .records.map((record) => record.id)
      .sort();
    expect(ids).toEqual(["project-agent", "root-agent"]);
    expect(reloaded.inventoryState().issues).toEqual([]);
  });

  test("list still returns valid records when the registry contains anomalies", async () => {
    const projectDir = path.join(storagePath, "tmp-project");
    await fs.mkdir(projectDir, { recursive: true });
    await storage.applySnapshot(createManagedAgent({ id: "valid-agent", cwd: "/tmp/project" }));
    const extraPath = path.join(projectDir, "extra.txt");
    await fs.writeFile(extraPath, "not a record", "utf8");

    const reloaded = new AgentStorage(storagePath, logger);
    const records = await reloaded.list();
    expect(records.map((record) => record.id)).toContain("valid-agent");

    const state = reloaded.inventoryState();
    expect(state.issues).toContainEqual({
      path: extraPath,
      reason: "unreadable_path",
    });
  });

  test("inventoryFreshState sees a valid record written after startup and rejects a later unknown entry", async () => {
    await storage.initialize();
    const lateDir = path.join(storagePath, "late-project");
    const latePath = path.join(lateDir, "late-agent.json");
    await fs.mkdir(lateDir, { recursive: true });
    await fs.writeFile(latePath, JSON.stringify(persistedRecord("late-agent")), "utf8");

    await expect(storage.inventoryFreshState()).resolves.toMatchObject({
      records: [expect.objectContaining({ id: "late-agent" })],
      issues: [],
    });

    const unexpected = path.join(storagePath, "unexpected.unknown");
    await fs.writeFile(unexpected, "unexpected", "utf8");
    await expect(storage.inventoryFreshState()).resolves.toMatchObject({
      records: expect.any(Array),
      issues: expect.arrayContaining([
        expect.objectContaining({ path: unexpected, reason: "unreadable_path" }),
      ]),
    });
  });

  test("inventoryFreshState fails closed when a valid file appears during its verified scan", async () => {
    const projectDir = path.join(storagePath, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "existing.json"),
      JSON.stringify(persistedRecord("existing")),
      "utf8",
    );
    const lateDir = path.join(storagePath, "late-project");
    const realReaddir = fs.readdir;
    let rootReads = 0;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === storagePath && ++rootReads === 2) {
        await fs.mkdir(lateDir, { recursive: true });
        await fs.writeFile(
          path.join(lateDir, "late.json"),
          JSON.stringify(persistedRecord("late")),
          "utf8",
        );
      }
      return realReaddir(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state).toEqual({
      records: [],
      issues: [{ path: storagePath, reason: "registry_changed" }],
    });
  });

  test("inventoryFreshState fails closed when a listed record disappears during the scan", async () => {
    const projectDir = path.join(storagePath, "project");
    const recordPath = path.join(projectDir, "agent.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(persistedRecord("agent")), "utf8");
    const realReadFile = fs.readFile;
    let intercepted = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === recordPath && !intercepted) {
        intercepted = true;
        await fs.unlink(recordPath);
      }
      return realReadFile(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state.issues).toContainEqual({ path: recordPath, reason: "registry_changed" });
  });

  test("inventoryFreshState fails closed when record content changes during the scan", async () => {
    const projectDir = path.join(storagePath, "project");
    const recordPath = path.join(projectDir, "agent.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(persistedRecord("agent")), "utf8");
    const realReadFile = fs.readFile;
    let intercepted = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === recordPath && !intercepted) {
        intercepted = true;
        const original = await realReadFile(...args);
        await fs.writeFile(
          recordPath,
          JSON.stringify(persistedRecord("agent", { lastStatus: "error" })),
          "utf8",
        );
        return original;
      }
      return realReadFile(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state.issues).toContainEqual({ path: recordPath, reason: "registry_changed" });
  });

  test("inventoryFreshState fails closed when a listed record is replaced during the scan", async () => {
    const projectDir = path.join(storagePath, "project");
    const recordPath = path.join(projectDir, "agent.json");
    const replacementPath = path.join(projectDir, "replacement.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(persistedRecord("agent")), "utf8");
    await fs.writeFile(replacementPath, JSON.stringify(persistedRecord("replacement")), "utf8");
    const realReadFile = fs.readFile;
    let intercepted = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === recordPath && !intercepted) {
        intercepted = true;
        await fs.rename(replacementPath, recordPath);
      }
      return realReadFile(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state.issues).toContainEqual({ path: recordPath, reason: "registry_changed" });
  });

  test("inventoryFreshState fails closed when a project directory disappears and reappears", async () => {
    const projectDir = path.join(storagePath, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent.json"),
      JSON.stringify(persistedRecord("agent")),
      "utf8",
    );
    const realReaddir = fs.readdir;
    let intercepted = false;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === projectDir && !intercepted) {
        intercepted = true;
        await fs.rm(projectDir, { recursive: true, force: true });
        await fs.mkdir(projectDir, { recursive: true });
      }
      return realReaddir(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state).toEqual({
      records: [],
      issues: [{ path: storagePath, reason: "registry_changed" }],
    });
  });

  test("inventoryFreshState fails closed when a project directory changes type during the scan", async () => {
    const projectDir = path.join(storagePath, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent.json"),
      JSON.stringify(persistedRecord("agent")),
      "utf8",
    );
    const realReaddir = fs.readdir;
    let intercepted = false;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === projectDir && !intercepted) {
        intercepted = true;
        await fs.rm(projectDir, { recursive: true, force: true });
        await fs.writeFile(projectDir, "no longer a directory", "utf8");
      }
      return realReaddir(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state.issues).toContainEqual({ path: projectDir, reason: "unreadable_path" });
  });

  test("inventoryFreshState fails closed when an unknown entry appears during the scan", async () => {
    const projectDir = path.join(storagePath, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent.json"),
      JSON.stringify(persistedRecord("agent")),
      "utf8",
    );
    const unexpected = path.join(storagePath, "unexpected.unknown");
    const realReaddir = fs.readdir;
    let rootReads = 0;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === storagePath && ++rootReads === 2) {
        await fs.writeFile(unexpected, "unexpected", "utf8");
      }
      return realReaddir(...args);
    });

    const state = await storage.inventoryFreshState();
    expect(state.issues).toContainEqual({ path: unexpected, reason: "unreadable_path" });
  });

  test.skipIf(process.platform === "win32")(
    "inventoryFreshState fails closed when a regular record becomes a symlink during the scan",
    async () => {
      const projectDir = path.join(storagePath, "project");
      const recordPath = path.join(projectDir, "agent.json");
      const targetPath = path.join(tmpDir, "outside.json");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(recordPath, JSON.stringify(persistedRecord("agent")), "utf8");
      await fs.writeFile(targetPath, JSON.stringify(persistedRecord("outside")), "utf8");
      const realReadFile = fs.readFile;
      let intercepted = false;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === recordPath && !intercepted) {
          intercepted = true;
          await fs.unlink(recordPath);
          await fs.symlink(targetPath, recordPath);
        }
        return realReadFile(...args);
      });

      const state = await storage.inventoryFreshState();
      expect(state.issues).toContainEqual({ path: recordPath, reason: "registry_changed" });
    },
  );

  test("inventoryFreshState is read-only and preserves the registry tree hash", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "fresh-read-only-agent" }));
    const before = await registryTreeHash(storagePath);
    await storage.inventoryFreshState();
    expect(await registryTreeHash(storagePath)).toBe(before);
  });

  test("writeRecord creates atomic temp files outside the registry scope", async () => {
    await storage.initialize();
    const paseoHome = path.dirname(storagePath);
    const atomicTempDir = path.join(paseoHome, ".tmp", "atomic");
    const realWriteFile = fs.writeFile;
    const observedTempPaths: string[] = [];

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(atomicTempDir)) {
        observedTempPaths.push(args[0]);
      }
      return realWriteFile(...args);
    });

    await storage.applySnapshot(createManagedAgent({ id: "temp-location-agent" }));
    writeFileSpy.mockRestore();

    expect(observedTempPaths.length).toBeGreaterThan(0);
    for (const tempPath of observedTempPaths) {
      expect(tempPath.startsWith(atomicTempDir)).toBe(true);
      expect(tempPath.startsWith(storagePath)).toBe(false);
    }
  });

  test("writeRecord cleans up temp files on rename failure", async () => {
    await storage.initialize();
    const paseoHome = path.dirname(storagePath);
    const atomicTempDir = path.join(paseoHome, ".tmp", "atomic");
    const realRename = fs.rename;
    let tempFilePath: string | null = null;

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(atomicTempDir)) {
        tempFilePath = args[0];
      }
      return realWriteFile(...args);
    });

    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (tempFilePath !== null && args[0] === tempFilePath) {
        throw new Error("injected rename failure");
      }
      return realRename(...args);
    });

    await expect(
      storage.applySnapshot(createManagedAgent({ id: "failing-agent" })),
    ).rejects.toThrow();

    writeFileSpy.mockRestore();
    renameSpy.mockRestore();

    expect(tempFilePath).not.toBeNull();
    await expect(fs.access(tempFilePath!)).rejects.toThrow();
    const registryEntries = await fs.readdir(storagePath, { withFileTypes: true });
    const tempInRegistry = registryEntries.filter((entry) => entry.name.endsWith(".tmp"));
    expect(tempInRegistry).toHaveLength(0);
  });

  test("inventoryFreshState is stable while an applySnapshot atomic write is in progress", async () => {
    await storage.initialize();
    type InventoryFreshResult = Awaited<ReturnType<AgentStorage["inventoryFreshState"]>>;
    const paseoHome = path.dirname(storagePath);
    const atomicTempDir = path.join(paseoHome, ".tmp", "atomic");
    const realWriteFile = fs.writeFile;
    let inventoryResult: InventoryFreshResult | null = null;

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (typeof filePath === "string" && filePath.startsWith(atomicTempDir)) {
        const result = await realWriteFile(...args);
        inventoryResult = await storage.inventoryFreshState();
        return result;
      }
      return realWriteFile(...args);
    });

    await storage.applySnapshot(createManagedAgent({ id: "concurrent-apply-agent" }));
    writeFileSpy.mockRestore();

    expect(inventoryResult).not.toBeNull();
    expect(inventoryResult!.issues).toEqual([]);

    const after = await storage.inventoryFreshState();
    expect(after.issues).toEqual([]);
    expect(after.records.map((record) => record.id)).toContain("concurrent-apply-agent");
  });

  test("inventoryFreshState is stable while an upsert atomic write is in progress", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "existing-upsert" }));
    type InventoryFreshResult = Awaited<ReturnType<AgentStorage["inventoryFreshState"]>>;
    const paseoHome = path.dirname(storagePath);
    const atomicTempDir = path.join(paseoHome, ".tmp", "atomic");
    const realWriteFile = fs.writeFile;
    let inventoryResult: InventoryFreshResult | null = null;

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (typeof filePath === "string" && filePath.startsWith(atomicTempDir)) {
        const result = await realWriteFile(...args);
        inventoryResult = await storage.inventoryFreshState();
        return result;
      }
      return realWriteFile(...args);
    });

    const existingRecord = await storage.get("existing-upsert");
    expect(existingRecord).not.toBeNull();
    await storage.upsert({ ...existingRecord!, title: "Updated title" });
    writeFileSpy.mockRestore();

    expect(inventoryResult).not.toBeNull();
    expect(inventoryResult!.issues).toEqual([]);
  });
});
