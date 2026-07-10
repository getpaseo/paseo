import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createLocalCheckoutWorkspace } from "../paseo-worktree-service.js";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  type PersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { archiveByScope, type ActiveWorkspaceRef } from "../workspace-archive-service.js";
import {
  ScheduleService,
  ScheduleTargetGoneError,
  type ScheduleServiceOptions,
} from "./service.js";
import { ScheduleStore } from "./store.js";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";

interface ScheduleServiceInternals {
  executeSchedule(schedule: StoredSchedule, runId: string): Promise<ScheduleExecutionResult>;
}

const SCHEDULE_TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

const NO_UNATTENDED_SCHEDULE_POLICY: Pick<ProviderSnapshotManager, "resolveCreateConfig"> = {
  async resolveCreateConfig(input) {
    return {
      modeId: input.unattended ? input.requestedMode : "interactive",
      featureValues: input.featureValues,
    };
  },
};

let workspaceArchiveInProgress = false;

type TestScheduleServiceOptions = Omit<
  ScheduleServiceOptions,
  | "createAgent"
  | "createLocalCheckoutWorkspace"
  | "createPaseoWorktreeWorkspace"
  | "archiveWorkspace"
> & {
  agentManager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createAgent?: ScheduleServiceOptions["createAgent"];
  createLocalCheckoutWorkspace?: ScheduleServiceOptions["createLocalCheckoutWorkspace"];
  createPaseoWorktreeWorkspace?: ScheduleServiceOptions["createPaseoWorktreeWorkspace"];
  archiveWorkspace?: ScheduleServiceOptions["archiveWorkspace"];
};

function createScheduleService(options: TestScheduleServiceOptions): ScheduleService {
  let workspaceCounter = 0;
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const workspaceGitService = createNoopWorkspaceGitService();
  const createDefaultWorkspace: ScheduleServiceOptions["createLocalCheckoutWorkspace"] = async (
    input,
  ) => {
    const timestamp = new Date().toISOString();
    const workspaceId = `wks_schedule_test_${++workspaceCounter}`;
    const workspace: PersistedWorkspaceRecord = {
      workspaceId,
      projectId: "test-project",
      cwd: input.cwd,
      kind: "directory",
      displayName: "test-project",
      title: input.firstAgentContext.prompt,
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    workspaces.set(workspaceId, workspace);
    return workspace;
  };
  const listActiveWorkspaces = async (): Promise<ActiveWorkspaceRef[]> =>
    Array.from(workspaces.values())
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
      }));
  const archiveDefaultWorkspace: ScheduleServiceOptions["archiveWorkspace"] = async (
    workspaceId,
  ) => {
    workspaceArchiveInProgress = true;
    try {
      await archiveByScope(
        {
          github: { invalidate: () => {} } as never,
          workspaceGitService,
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          findWorkspaceIdForCwd: async (cwd) =>
            Array.from(workspaces.values()).find((workspace) => workspace.cwd === cwd)
              ?.workspaceId ?? null,
          listActiveWorkspaces,
          archiveWorkspaceRecord: async (id) => {
            const workspace = workspaces.get(id);
            if (workspace) {
              workspaces.set(id, { ...workspace, archivedAt: new Date().toISOString() });
            }
          },
          emitWorkspaceUpdatesForWorkspaceIds: async () => {},
          markWorkspaceArchiving: () => {},
          clearWorkspaceArchiving: () => {},
          killTerminalsForWorkspace: async () => {},
          sessionLogger: options.logger,
        },
        {
          scope: { kind: "workspace", workspaceId },
          repoRoot: null,
          requestId: "schedule-service-test",
        },
      );
    } finally {
      workspaceArchiveInProgress = false;
    }
  };
  return new ScheduleService({
    ...options,
    createAgent:
      options.createAgent ??
      ((input) =>
        createAgentCommand(
          {
            agentManager: options.agentManager,
            agentStorage: options.agentStorage,
            logger: options.logger,
            providerSnapshotManager: options.providerSnapshotManager as ProviderSnapshotManager,
          },
          input,
        )),
    createLocalCheckoutWorkspace: options.createLocalCheckoutWorkspace ?? createDefaultWorkspace,
    createPaseoWorktreeWorkspace:
      options.createPaseoWorktreeWorkspace ??
      (async (input) => {
        const workspace = await createDefaultWorkspace(input);
        return {
          workspace,
          worktree: { branchName: "schedule-test", worktreePath: workspace.cwd },
          intent: { kind: "branch-off", baseBranch: "main", branchName: "schedule-test" },
          repoRoot: workspace.cwd,
          created: true,
        };
      }),
    archiveWorkspace: options.archiveWorkspace ?? archiveDefaultWorkspace,
  });
}

async function createRegistryBackedScheduleWorkspaceDeps(rootDir: string): Promise<{
  workspaceRegistry: FileBackedWorkspaceRegistry;
  createLocalCheckoutWorkspace: ScheduleServiceOptions["createLocalCheckoutWorkspace"];
  createArchiveWorkspace: (input: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger?: ScheduleServiceOptions["logger"];
  }) => ScheduleServiceOptions["archiveWorkspace"];
}> {
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(rootDir, "projects", "workspaces.json"),
    createTestLogger(),
  );
  const projectRegistry = new FileBackedProjectRegistry(
    join(rootDir, "projects", "projects.json"),
    createTestLogger(),
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  const workspaceGitService = createNoopWorkspaceGitService();
  return {
    workspaceRegistry,
    createLocalCheckoutWorkspace: async (input) => {
      return createLocalCheckoutWorkspace(
        { cwd: input.cwd, title: input.firstAgentContext.prompt },
        { projectRegistry, workspaceRegistry, workspaceGitService },
      );
    },
    createArchiveWorkspace:
      ({ agentManager, agentStorage, logger = createTestLogger() }) =>
      async (workspaceId) => {
        workspaceArchiveInProgress = true;
        try {
          await archiveByScope(
            {
              github: { invalidate: () => {} } as never,
              workspaceGitService,
              agentManager,
              agentStorage,
              findWorkspaceIdForCwd: async (cwd) =>
                resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list()),
              listActiveWorkspaces: async () =>
                (await workspaceRegistry.list())
                  .filter((workspace) => !workspace.archivedAt)
                  .map((workspace) => ({
                    workspaceId: workspace.workspaceId,
                    cwd: workspace.cwd,
                    kind: workspace.kind,
                  })),
              archiveWorkspaceRecord: async (id) => {
                await workspaceRegistry.archive(id, new Date().toISOString());
              },
              emitWorkspaceUpdatesForWorkspaceIds: async () => {},
              markWorkspaceArchiving: () => {},
              clearWorkspaceArchiving: () => {},
              killTerminalsForWorkspace: async () => {},
              sessionLogger: logger,
            },
            {
              scope: { kind: "workspace", workspaceId },
              repoRoot: null,
              requestId: "schedule-service-test",
            },
          );
        } finally {
          workspaceArchiveInProgress = false;
        }
      },
  };
}

function buildAgentRecord(params: {
  id: string;
  cwd: string;
  iso: string;
  archivedAt?: string | null;
}) {
  return {
    id: params.id,
    provider: "claude",
    cwd: params.cwd,
    createdAt: params.iso,
    updatedAt: params.iso,
    lastActivityAt: params.iso,
    lastUserMessageAt: null,
    title: params.id,
    labels: {},
    lastStatus: "closed" as const,
    lastModeId: "default",
    config: { modeId: "default" },
    runtimeInfo: null,
    features: [],
    persistence: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: params.archivedAt ?? null,
  };
}

describe("ScheduleService", () => {
  let tempDir: string;
  let agentStorage: AgentStorage;
  let now: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-service-test-"));
    await mkdir(join(tempDir, "agents"), { recursive: true });
    agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    now = new Date("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    // Drain pending background persists before deleting the dir to avoid
    // ENOTEMPTY races when AgentManager flushes a snapshot mid-cleanup.
    await agentStorage.flush();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("ticks due schedules and records run history on disk", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000001",
        output: `ran:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "Review new PRs",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000001",
      output: "ran:Review new PRs",
    });
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("pause and resume update persisted schedule state", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "ok",
      }),
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    now = new Date("2026-01-01T00:03:00.000Z");
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
  });

  test("completes schedules when max runs is reached", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "done",
      }),
    });

    const created = await service.create({
      prompt: "One shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
  });

  test("executes new-agent schedules through AgentManager with real fake clients", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    expect(inspected.runs[0]?.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("titles scheduled new agents from the schedule prompt", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Audit flaky checkout flow\n\nReport only blockers.",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.title).toBe("Audit flaky checkout flow");
  });

  test("new-agent schedule records create no workspace until run time", async () => {
    const { workspaceRegistry, createLocalCheckoutWorkspace: createScheduleLocalWorkspace } =
      await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "server-owned workspace happens at run time",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      runOnCreate: false,
    });

    expect(created.target.config).toMatchObject({
      provider: "claude",
      model: "test-model",
      cwd: tempDir,
    });
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("archiveOnFinish=false local runs create one active workspace per run", async () => {
    const {
      workspaceRegistry,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "repeat in separate workspaces",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      maxRuns: 2,
    });

    await service.tick();
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(2);
    const firstAgent = await agentStorage.get(inspected.runs[0]!.agentId!);
    const secondAgent = await agentStorage.get(inspected.runs[1]!.agentId!);
    expect(firstAgent?.workspaceId).toMatch(/^wks_/);
    expect(secondAgent?.workspaceId).toMatch(/^wks_/);
    expect(firstAgent?.workspaceId).not.toBe(secondAgent?.workspaceId);
    expect(firstAgent?.archivedAt ?? null).toBeNull();
    expect(secondAgent?.archivedAt ?? null).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        workspaceId: firstAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
      expect.objectContaining({
        workspaceId: secondAgent?.workspaceId,
        cwd: tempDir,
        archivedAt: null,
      }),
    ]);
  });

  test("archiveOnFinish=true archives the run workspace through workspace archive", async () => {
    const {
      workspaceRegistry,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const archiveAgent = manager.archiveAgent.bind(manager);
    manager.archiveAgent = async (agentId) => {
      if (!workspaceArchiveInProgress) {
        throw new Error("scheduled runs must archive workspaces, not agents directly");
      }
      return archiveAgent(agentId);
    };
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      now: () => now,
    });

    const created = await service.create({
      prompt: "archive the run workspace",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          isolation: "local",
        },
      },
      maxRuns: 1,
    });

    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.workspaceId).toMatch(/^wks_/);
    expect(storedAgent?.archivedAt).toEqual(expect.any(String));
    expect(await workspaceRegistry.get(storedAgent!.workspaceId!)).toEqual(
      expect.objectContaining({
        workspaceId: storedAgent?.workspaceId,
        archivedAt: expect.any(String),
      }),
    );
  });

  test("archives the run workspace when scheduled agent creation fails before archive opt-out can preserve an agent", async () => {
    const {
      workspaceRegistry,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      createArchiveWorkspace,
    } = await createRegistryBackedScheduleWorkspaceDeps(tempDir);
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const createError = new Error("provider misconfigured");
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createLocalCheckoutWorkspace: createScheduleLocalWorkspace,
      archiveWorkspace: createArchiveWorkspace({
        agentManager: manager,
        agentStorage,
      }),
      createAgent: async () => {
        throw createError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail before agent exists",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          archiveOnFinish: false,
          isolation: "local",
        },
      },
      runOnCreate: false,
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(created, "run-create-fails"),
    ).rejects.toThrow("provider misconfigured");

    expect(await workspaceRegistry.list()).toEqual([
      expect.objectContaining({
        cwd: tempDir,
        archivedAt: expect.any(String),
      }),
    ]);
  });

  test("new-agent cwd existence is checked at run time, not when editing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "missing cwd can be configured",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: join(tempDir, "does-not-exist") },
      },
      runOnCreate: false,
    });

    const updated = await service.update({
      id: created.id,
      newAgentConfig: { cwd: join(tempDir, "also-missing") },
    });

    expect(updated.target.config).toMatchObject({
      provider: "claude",
      cwd: join(tempDir, "also-missing"),
    });
  });

  test("concurrent run finish and update preserve the target config and run outcome", async () => {
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const store = new ScheduleStore(join(tempDir, "schedules"));
    const legacy = await store.create({
      name: null,
      prompt: "finish/update race",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: now.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished while updating",
        };
      },
    });

    const tickPromise = service.tick();
    await runStarted;
    const updatePromise = service.update({
      id: legacy.id,
      newAgentConfig: { modeId: "full-access" },
    });
    finishRun?.();
    await Promise.all([tickPromise, updatePromise]);

    const inspected = await service.inspect(legacy.id);
    expect(inspected.target).toMatchObject({
      type: "new-agent",
      config: {
        modeId: "full-access",
      },
    });
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "finished while updating",
      error: null,
    });
  });

  test("scheduled new-agent slash prompts run as normal foreground prompts", async () => {
    const createdInputs: Parameters<ScheduleServiceOptions["createAgent"]>[0][] = [];
    const runPrompts: AgentPromptInput[] = [];
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async (_agentId, prompt) => {
      runPrompts.push(prompt);
      return {
        sessionId: "scheduled-slash-run",
        finalText: "compacted",
        timeline: [{ type: "assistant_message", text: "compacted" }],
      };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: "compacted",
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        createdInputs.push(input);
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000322",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "/compact",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0].initialPrompt).toBeUndefined();
    expect(runPrompts).toEqual(["/compact"]);
    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      output: "compacted",
    });
  });

  test("scheduled new-agent run output falls back to final text and curated timeline", async () => {
    let runCount = 0;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      runCount += 1;
      return runCount === 1
        ? {
            sessionId: "scheduled-final-text-run",
            finalText: "final text output",
            timeline: [],
          }
        : {
            sessionId: "scheduled-timeline-run",
            finalText: "",
            timeline: [{ type: "assistant_message", text: "timeline output" }],
          };
    };
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id:
            runCount === 0
              ? "00000000-0000-0000-0000-000000000323"
              : "00000000-0000-0000-0000-000000000324",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const finalTextSchedule = await service.create({
      prompt: "final text",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    const timelineSchedule = await service.create({
      prompt: "timeline",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });

    await service.runOnce(finalTextSchedule.id);
    await service.runOnce(timelineSchedule.id);

    expect((await service.inspect(finalTextSchedule.id)).runs[0]?.output).toBe("final text output");
    expect((await service.inspect(timelineSchedule.id)).runs[0]?.output).toContain(
      "timeline output",
    );
  });

  test("scheduled new-agent cancellations fail the run", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => ({
      sessionId: "scheduled-canceled-run",
      finalText: "",
      timeline: [],
      canceled: true,
    });
    manager.waitForAgentEvent = async () => ({
      status: "idle",
      permission: null,
      lastMessage: null,
    });
    manager.archiveAgent = async () => {};
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: "00000000-0000-0000-0000-000000000325",
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "cancel me",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("was canceled"),
    });
  });

  test("failed new-agent run keeps run error when workspace archive also fails", async () => {
    const logger = createTestLogger();
    const warn = vi.fn();
    logger.warn = warn as typeof logger.warn;
    logger.child = (() => logger) as typeof logger.child;
    const archiveError = new Error("archive exploded");
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    manager.runAgent = async () => {
      throw new Error("run exploded");
    };
    const agentId = "00000000-0000-0000-0000-000000000326";
    const service = createScheduleService({
      paseoHome: tempDir,
      logger,
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      createAgent: async (input) => {
        const snapshot = {
          id: agentId,
          provider: "claude",
          cwd: input.cwd ?? tempDir,
          workspaceId: input.workspaceId,
          status: "idle",
          lifecycle: "idle",
        };
        return {
          snapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["snapshot"],
          liveSnapshot: snapshot as Awaited<
            ReturnType<ScheduleServiceOptions["createAgent"]>
          >["liveSnapshot"],
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        };
      },
      archiveWorkspace: async () => {
        throw archiveError;
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "fail and fail cleanup",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      maxRuns: 1,
    });
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      error: "run exploded",
      agentId,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: archiveError,
        agentId,
        workspaceId: expect.stringMatching(/^wks_/),
        scheduleId: created.id,
        runId: expect.any(String),
      }),
      expect.stringContaining("Failed to archive scheduled workspace"),
    );
  });

  test("shows scheduled new-agent prompts as normal user turns", async () => {
    class PromptEchoScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-prompt-echo-session";
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      async run(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        const turnId = `run-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        this.emit({ type: "turn_started", provider: this.provider, turnId });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "user_message", text: textPrompt },
        });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: "done" },
        });
        this.emit({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "user_message", text: textPrompt },
          });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(_modeId: string): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class PromptEchoScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
        return new PromptEchoScheduleSession();
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: new PromptEchoScheduleClient() },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });
    const observedUserMessages: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      if (event.type !== "agent_stream" || event.event.type !== "timeline") {
        return;
      }
      if (event.event.item.type === "user_message") {
        observedUserMessages.push(event.event.item.text);
      }
    });

    const created = await service.create({
      prompt: "Audit nightly run",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    try {
      await service.tick();
    } finally {
      unsubscribe();
    }

    expect(observedUserMessages).toEqual(["Audit nightly run"]);
    expect((await service.inspect(created.id)).runs[0]?.status).toBe("succeeded");
  });

  test("archives new-agent schedule sessions after the run finishes", async () => {
    class CountingScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id: string;
      closed = false;
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      constructor(private readonly config: AgentSessionConfig) {
        this.id = "scheduled-session-1";
      }

      async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "done",
          timeline: [{ type: "assistant_message", text: "done" }],
        };
      }

      async startTurn(
        _prompt: AgentPromptInput,
        _options?: AgentRunOptions,
      ): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnCount}`;
        setImmediate(() => {
          this.emit({ type: "turn_started", provider: this.provider, turnId });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: "done" },
          });
          this.emit({
            type: "turn_completed",
            provider: this.provider,
            turnId,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        });
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: this.config.model ?? null,
          modeId: this.config.modeId ?? null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return this.config.modeId ?? null;
      }

      async setMode(modeId: string): Promise<void> {
        this.config.modeId = modeId;
      }

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        _response: AgentPermissionResponse,
      ): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
          metadata: { ...this.config },
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {
        this.closed = true;
      }

      private emit(event: AgentStreamEvent): void {
        for (const subscriber of this.subscribers) {
          subscriber(event);
        }
      }
    }

    class CountingScheduleClient implements AgentClient {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly sessions: CountingScheduleSession[] = [];

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new CountingScheduleSession(config);
        this.sessions.push(session);
        return session;
      }

      async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
        const metadata = handle.metadata as Partial<AgentSessionConfig> | undefined;
        const session = new CountingScheduleSession({
          ...metadata,
          provider: this.provider,
          cwd: metadata?.cwd ?? tempDir,
        });
        this.sessions.push(session);
        return session;
      }

      async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
        return { models: [], modes: [] };
      }

      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const client = new CountingScheduleClient();
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: client },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "finish and stop",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.closed).toBe(true);
    expect(manager.getAgent(agentId!)).toBeNull();
    const storedAgent = await agentStorage.get(agentId!);
    expect(storedAgent?.archivedAt).toBeTruthy();
  });

  test("records prompt-start failures as failed and archives the scheduled agent", async () => {
    class StartFailureScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-start-failure-session";

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("start turn exploded");
      }

      subscribe(): () => void {
        return () => {};
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: {
        claude: {
          provider: "claude",
          capabilities: SCHEDULE_TEST_CAPABILITIES,
          createSession: async () => new StartFailureScheduleSession(),
          resumeSession: async () => new StartFailureScheduleSession(),
          fetchCatalog: async () => ({ models: [], modes: [] }),
          isAvailable: async () => true,
        },
      },
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "this run fails before starting",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: expect.any(String),
      error: expect.stringContaining("start turn exploded"),
    });
    const storedAgents = await agentStorage.list();
    expect(storedAgents).toHaveLength(1);
    expect(inspected.runs[0]?.agentId).toBe(storedAgents[0]?.id);
    expect(storedAgents[0]).toMatchObject({
      archivedAt: expect.any(String),
    });
  });

  test("defaults new-agent modeId to provider's unattended mode", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "bypassPermissions" : "interactive",
            featureValues: input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    const agent = await agentStorage.get(agentId!);
    expect(agent?.lastModeId).toBe("bypassPermissions");
    expect(agent?.archivedAt).toBeTruthy();
  });

  test("defaults OpenCode new-agent schedules to build plus auto accept", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const opencodeClient = clients.opencode;
    if (!opencodeClient) {
      throw new Error("Expected OpenCode test client");
    }
    clients.opencode = {
      provider: opencodeClient.provider,
      capabilities: opencodeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return opencodeClient.createSession(...args);
      },
      resumeSession: (...args) => opencodeClient.resumeSession(...args),
      fetchCatalog: (...args) => opencodeClient.fetchCatalog(...args),
      isAvailable: () => opencodeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "build" : "interactive",
            featureValues: input.unattended
              ? { ...input.featureValues, auto_accept: true }
              : input.featureValues,
          };
        },
      },
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "opencode",
          model: "test-model",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs[0]?.error).toBeNull();
    expect(createdConfigs[0]).toMatchObject({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
  });

  test("forwards stored new-agent session config to the launched scheduled agent", async () => {
    const createdConfigs: AgentSessionConfig[] = [];
    const clients = createTestAgentClients();
    const claudeClient = clients.claude;
    if (!claudeClient) {
      throw new Error("Expected Claude test client");
    }
    clients.claude = {
      provider: claudeClient.provider,
      capabilities: claudeClient.capabilities,
      createSession: async (...args) => {
        createdConfigs.push(args[0]);
        return claudeClient.createSession(...args);
      },
      resumeSession: (...args) => claudeClient.resumeSession(...args),
      fetchCatalog: (...args) => claudeClient.fetchCatalog(...args),
      isAvailable: () => claudeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      registry: agentStorage,
    });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: "stored-mode",
          });
          return {
            modeId: input.requestedMode,
            featureValues: { ...input.featureValues, resolved: true },
          };
        },
      },
      now: () => now,
    });

    await service.create({
      prompt: "Use the stored launch config",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          model: "test-model",
          cwd: tempDir,
          title: "Stored launch title",
          modeId: "stored-mode",
          thinkingOptionId: "think-hard",
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
          networkAccess: true,
          webSearch: true,
          featureValues: { auto_accept: true },
          extra: { codex: { profile: "full-access" } },
          systemPrompt: "Stay concise.",
          mcpServers: {
            docs: {
              command: "node",
              args: ["docs-server.js"],
            },
          },
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0]).toMatchObject({
      provider: "claude",
      cwd: tempDir,
      title: "Stored launch title",
      model: "test-model",
      modeId: "stored-mode",
      thinkingOptionId: "think-hard",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      networkAccess: true,
      webSearch: true,
      featureValues: { auto_accept: true, resolved: true },
      extra: { codex: { profile: "full-access" } },
      systemPrompt: "Stay concise.",
      mcpServers: {
        docs: {
          command: "node",
          args: ["docs-server.js"],
        },
      },
    });
  });

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service1.create({
      prompt: "Periodic check",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
    await service1.stop();

    // Simulate daemon restart 10 minutes later
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    const inspected = await service2.inspect(created.id);
    expect(new Date(inspected.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace with an associated agent", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted after creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const associatedAgentId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "wks_interrupted_with_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"));
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-with-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: associatedAgentId,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: Array<{ workspaceId: string; repoRoot: string }> = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId, repoRoot) => {
        archiveCalls.push({ workspaceId: archivedWorkspaceId, repoRoot });
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([{ workspaceId, repoRoot: tempDir }]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: associatedAgentId,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("startup recovery archives an interrupted run workspace even before agent association", async () => {
    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    const created = await service1.create({
      prompt: "Interrupted before creating an agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, archiveOnFinish: false },
      },
      runOnCreate: false,
    });
    await service1.stop();

    const interruptedAt = now.toISOString();
    const workspaceId = "wks_interrupted_without_agent";
    const store = new ScheduleStore(join(tempDir, "schedules"));
    await store.update(created.id, (schedule) => ({
      ...schedule,
      runs: [
        ...schedule.runs,
        {
          id: "run-interrupted-without-agent",
          scheduledFor: interruptedAt,
          startedAt: interruptedAt,
          endedAt: null,
          status: "running",
          agentId: null,
          workspaceId,
          output: null,
          error: null,
        },
      ],
    }));

    const archiveCalls: Array<{ workspaceId: string; repoRoot: string }> = [];
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
      archiveWorkspace: async (archivedWorkspaceId, repoRoot) => {
        archiveCalls.push({ workspaceId: archivedWorkspaceId, repoRoot });
      },
    });
    await service2.start();

    expect(archiveCalls).toEqual([{ workspaceId, repoRoot: tempDir }]);
    const inspected = await service2.inspect(created.id);
    expect(inspected.runs[0]).toMatchObject({
      status: "failed",
      agentId: null,
      error: "Daemon restarted before the scheduled run completed",
    });
    await service2.stop();
  });

  test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished",
        };
      },
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    const tickPromise = service.tick();
    await runStarted;

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    finishRun?.();
    await tickPromise;

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("paused");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("rejects archived target agents before loading them", async () => {
    const manager = new AgentManager({ logger: createTestLogger() });
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    await agentStorage.upsert({
      id: "archived-agent",
      provider: "claude",
      cwd: tempDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      lastUserMessageAt: null,
      title: "Archived Agent",
      labels: {},
      lastStatus: "closed",
      lastModeId: "default",
      config: {
        modeId: "default",
      },
      runtimeInfo: null,
      features: [],
      persistence: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule(
        {
          id: "schedule-1",
          name: null,
          prompt: "Check archived agent",
          cadence: { type: "every", everyMs: 60_000 },
          target: {
            type: "agent",
            agentId: "archived-agent",
          },
          status: "active",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          nextRunAt: now.toISOString(),
          lastRunAt: null,
          pausedAt: null,
          expiresAt: null,
          maxRuns: null,
          runs: [],
        },
        "run-1",
      ),
    ).rejects.toThrow("Agent archived-agent is archived");
  });

  test("defaults --every schedules to fire immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "every default",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("--every with runOnCreate=false waits the full interval", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "wait interval",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("--cron defaults to the next cron slot", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron default",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
  });

  test("--cron with runOnCreate=true fires immediately on creation", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron run-now",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: true,
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("runOnce records a run without changing nextRunAt or completing the schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000099",
        output: `manual:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "manual fire",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const after = await service.runOnce(created.id);
    expect(after.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(after.status).toBe("active");
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000099",
      output: "manual:manual fire",
    });
  });

  test("update mutates cadence, prompt, name, and target fields in place", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "morning",
      prompt: "first prompt",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, modeId: "default" },
      },
    });
    expect(created.runs).toEqual([]);

    now = new Date("2026-01-01T00:00:30.000Z");
    const nextCwd = join(tempDir, "new-path");
    await mkdir(nextCwd, { recursive: true });
    const updated = await service.update({
      id: created.id,
      prompt: "second prompt",
      name: "renamed",
      cadence: { type: "every", everyMs: 5 * 60_000 },
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
        cwd: nextCwd,
      },
    });

    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60_000 });
    expect(updated.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: nextCwd,
        model: "gpt-5",
        modeId: "full-access",
        thinkingOptionId: "deep-thought",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:00:00.000Z");

    const cron = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
    expect(cron.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(cron.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const back = await service.update({
      id: created.id,
      cadence: { type: "every", everyMs: 2 * 60_000 },
    });
    expect(back.cadence).toEqual({ type: "every", everyMs: 2 * 60_000 });
    expect(back.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("update preserves a cron cadence timezone when the new cadence omits it", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const updated = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });

    expect(updated.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ran" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const after = await service.inspect(created.id);
    expect(after.runs).toHaveLength(1);

    now = new Date("2026-01-01T00:01:30.000Z");
    const updated = await service.update({ id: created.id, prompt: "new prompt" });

    expect(updated.prompt).toBe("new prompt");
    expect(updated.cadence).toEqual(created.cadence);
    expect(updated.nextRunAt).toBe(after.nextRunAt);
    expect(updated.runs).toEqual(after.runs);
    expect(updated.lastRunAt).toBe(after.lastRunAt);
  });

  test("update clears the schedule name when given an empty string", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "named",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.name).toBe("named");

    const cleared = await service.update({ id: created.id, name: "" });
    expect(cleared.name).toBeNull();

    const renamed = await service.update({ id: created.id, name: "again" });
    expect(renamed.name).toBe("again");
  });

  test("update rejects new-agent fields on agent-target schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "agent target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000005" },
    });

    await expect(
      service.update({
        id: created.id,
        newAgentConfig: { provider: "codex" },
      }),
    ).rejects.toThrow("only valid for new-agent target schedules");
  });

  test("update changes individual new-agent fields independently", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, model: "sonnet", modeId: "default" },
      },
    });

    const modeOnly = await service.update({
      id: created.id,
      newAgentConfig: { modeId: "bypassPermissions" },
    });
    expect(modeOnly.target).toMatchObject({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: tempDir,
        model: "sonnet",
        modeId: "bypassPermissions",
      },
    });

    const clearModel = await service.update({
      id: created.id,
      newAgentConfig: { model: null },
    });
    if (clearModel.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(clearModel.target.config.model).toBeUndefined();
    expect(clearModel.target.config.modeId).toBe("bypassPermissions");
  });

  test("update returns a schedule that round-trips through the store", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "0 9 * * *" },
      newAgentConfig: { provider: "codex", modeId: "full-access" },
    });

    const reloaded = await service.inspect(created.id);
    expect(reloaded.cadence).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(reloaded.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: tempDir,
        modeId: "full-access",
      },
    });
  });

  test("runOnce rejects completed schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "one-shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    await expect(service.runOnce(created.id)).rejects.toThrow("already completed");
  });

  test("completeForAgent completes only schedules targeting that agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const targetAgentId = "11111111-1111-4111-8111-111111111111";
    const otherAgentId = "22222222-2222-4222-8222-222222222222";

    const targeted = await service.create({
      prompt: "ping the doomed agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: targetAgentId },
    });
    const otherTargeted = await service.create({
      prompt: "ping the other agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: otherAgentId },
    });
    const newAgentSchedule = await service.create({
      prompt: "spawn a fresh agent",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    now = new Date("2026-01-01T00:05:00.000Z");
    const completed = await service.completeForAgent(targetAgentId);
    expect(completed).toBe(1);

    const remaining = await service.list();
    expect(remaining.map((schedule) => schedule.id).sort()).toEqual(
      [targeted.id, otherTargeted.id, newAgentSchedule.id].sort(),
    );

    const doomed = await service.inspect(targeted.id);
    expect(doomed.status).toBe("completed");
    expect(doomed.nextRunAt).toBeNull();
    expect(doomed.updatedAt).toBe("2026-01-01T00:05:00.000Z");

    expect((await service.inspect(otherTargeted.id)).status).toBe("active");
    expect((await service.inspect(newAgentSchedule.id)).status).toBe("active");
  });

  test("startup sweep completes agent-target schedules whose agent is gone", async () => {
    const missingAgentId = "44444444-4444-4444-8444-444444444444";
    const archivedAgentId = "55555555-5555-4555-8555-555555555555";
    const liveAgentId = "66666666-6666-4666-8666-666666666666";

    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    await agentStorage.upsert(
      buildAgentRecord({ id: liveAgentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const service1 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const missing = await service1.create({
      prompt: "ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: missingAgentId },
    });
    const archived = await service1.create({
      prompt: "ping archived",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });
    const live = await service1.create({
      prompt: "ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    const newAgent = await service1.create({
      prompt: "spawn fresh",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const pausedMissing = await service1.create({
      prompt: "paused ping missing",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" },
    });
    await service1.pause(pausedMissing.id);
    const pausedLive = await service1.create({
      prompt: "paused ping live",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: liveAgentId },
    });
    await service1.pause(pausedLive.id);

    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();
    await service2.stop();

    expect((await service2.inspect(missing.id)).status).toBe("completed");
    expect((await service2.inspect(missing.id)).nextRunAt).toBeNull();
    expect((await service2.inspect(archived.id)).status).toBe("completed");
    expect((await service2.inspect(live.id)).status).toBe("active");
    expect((await service2.inspect(newAgent.id)).status).toBe("active");
    // Paused schedules are swept too when their agent is gone, but survive when it lives.
    expect((await service2.inspect(pausedMissing.id)).status).toBe("completed");
    expect((await service2.inspect(pausedLive.id)).status).toBe("paused");
  });

  test("completes the schedule when a scheduled run reports the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new ScheduleTargetGoneError("Agent 77777777-7777-4777-8777-777777777777 is archived");
      },
    });

    const created = await service.create({
      prompt: "ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "77777777-7777-4777-8777-777777777777" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("Agent 77777777-7777-4777-8777-777777777777 is archived");
  });

  test("does not resurrect nextRunAt when the schedule completes during an in-flight run", async () => {
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let service!: ScheduleService;
    service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        // Simulate the agent being archived mid-run: the archive callback
        // completes the schedule before this run finishes.
        await service.completeForAgent(agentId);
        return { agentId: null, output: "ok" };
      },
    });

    const created = await service.create({
      prompt: "ping",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("keeps the schedule active when a run fails for a transient reason", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => {
        throw new Error("network blip");
      },
    });

    const created = await service.create({
      prompt: "ping flaky target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "88888888-8888-4888-8888-888888888888" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toBe("network blip");
  });

  test("completes the schedule when a scheduled run targets an archived agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const archivedAgentId = "99999999-9999-4999-8999-999999999999";
    await agentStorage.upsert(
      buildAgentRecord({
        id: archivedAgentId,
        cwd: tempDir,
        iso: now.toISOString(),
        archivedAt: "2026-01-01T00:00:30.000Z",
      }),
    );

    const created = await service.create({
      prompt: "ping archived target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: archivedAgentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("is archived");
  });

  test("completes the schedule when a scheduled run targets a missing agent", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "ping missing target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
  });

  test("completes the schedule when a new-agent run's cwd no longer exists", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const deletedWorktree = join(tempDir, "deleted-worktree");
    await mkdir(deletedWorktree, { recursive: true });
    const created = await service.create({
      prompt: "spawn in a deleted dir",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: deletedWorktree,
          approvalPolicy: "never",
        },
      },
    });
    await rm(deletedWorktree, { recursive: true, force: true });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("no longer exists");
  });

  test("keeps the schedule active when a real run fails for a non-gone reason", async () => {
    // No providers registered: the agent exists and is live, but loading it fails
    // with a plain error (not ScheduleTargetGoneError), so the schedule must retry.
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const agentId = "12121212-1212-4121-8121-121212121212";
    await agentStorage.upsert(
      buildAgentRecord({ id: agentId, cwd: tempDir, iso: now.toISOString() }),
    );

    const created = await service.create({
      prompt: "ping live but unavailable",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("active");
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    expect(inspected.runs[0]?.status).toBe("failed");
    expect(inspected.runs[0]?.error).toContain("unavailable provider");
  });

  test("runOnce completes the schedule when the target is gone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
    });

    const created = await service.create({
      prompt: "manual ping gone target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "13131313-1313-4131-8131-131313131313" },
    });

    const after = await service.runOnce(created.id);
    expect(after.status).toBe("completed");
    expect(after.nextRunAt).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]?.status).toBe("failed");
  });

  test("createOrReplace updates the matching schedule in place instead of duplicating", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(first.id)).runs).toHaveLength(1);
    await service.pause(first.id);

    now = new Date("2026-01-01T00:02:00.000Z");
    const second = await service.createOrReplace({
      name: "babysit-pr PR 1112",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.prompt).toBe("watch the build v2");
    expect(second.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(second.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.runs).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace preserves an existing cron timezone when replacement omits timezone", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build",
      cadence: { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
      target: { type: "agent", agentId },
    });

    const second = await service.createOrReplace({
      name: "timezone-aware cron",
      prompt: "watch the build v2",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: { type: "agent", agentId },
    });

    expect(second.id).toBe(first.id);
    expect(second.cadence).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace creates a sibling when name, target, or completion differ", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const agentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "other",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    await service.createOrReplace({
      name: "dup",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentB },
    });

    const done = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    expect((await service.inspect(done.id)).status).toBe("completed");

    const redone = await service.createOrReplace({
      name: "done",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: agentA },
    });
    expect(redone.id).not.toBe(done.id);

    expect(await service.list()).toHaveLength(5);
  });

  test("createOrReplace never dedups anonymous schedules", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });
    await service.createOrReplace({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
    });

    expect(await service.list()).toHaveLength(2);
  });

  test("createOrReplace matches new-agent targets by config", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);

    const subCwd = join(tempDir, "sub");
    await mkdir(subCwd, { recursive: true });
    const third = await service.createOrReplace({
      name: "nightly",
      prompt: "audit elsewhere",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: subCwd } },
    });
    expect(third.id).not.toBe(first.id);
    expect(await service.list()).toHaveLength(2);
  });

  test("concurrent createOrReplace first creates share one schedule", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const firstPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    const secondPromise = service.createOrReplace({
      name: "nightly race",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("createOrReplace dedups new-agent targets regardless of config key order", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    // The stored config is round-tripped through the Zod schema (schema key
    // order); this incoming literal deliberately uses a different key order.
    const first = await service.createOrReplace({
      name: "nightly",
      prompt: "audit",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          networkAccess: true,
          title: "nightly job",
          approvalPolicy: "never",
        },
      },
    });
    const second = await service.createOrReplace({
      name: "nightly",
      prompt: "audit v2",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          networkAccess: true,
          title: "nightly job",
          approvalPolicy: "never",
        },
      },
    });

    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);
  });

  test("completeForAgent skips schedules that are already completed", async () => {
    const service = createScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      providerSnapshotManager: NO_UNATTENDED_SCHEDULE_POLICY,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const agentId = "33333333-3333-4333-8333-333333333333";
    await service.create({
      prompt: "already done",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    expect(await service.completeForAgent(agentId)).toBe(1);
    expect(await service.completeForAgent(agentId)).toBe(0);
  });
});
