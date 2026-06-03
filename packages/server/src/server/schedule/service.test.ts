import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
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
  ListModelsOptions,
} from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { ScheduleService } from "./service.js";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";

interface ScheduleServiceInternals {
  executeSchedule(schedule: StoredSchedule): Promise<ScheduleExecutionResult>;
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
    expect(input).toMatchObject({ parent: null, unattended: true, requestedMode: undefined });
    return { modeId: undefined, featureValues: input.featureValues };
  },
};

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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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

  test("shows scheduled new-agent prompts as normal user turns", async () => {
    class PromptEchoScheduleSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = SCHEDULE_TEST_CAPABILITIES;
      readonly id = "scheduled-prompt-echo-session";
      private turnCount = 0;
      private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

      async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
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

      async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
        return [];
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
    const service = new ScheduleService({
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

      async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
        return [];
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
    const service = new ScheduleService({
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

  test("defaults new-agent modeId to provider's unattended mode", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = new ScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({ parent: null, unattended: true, requestedMode: undefined });
          return { modeId: "bypassPermissions", featureValues: input.featureValues };
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
      listModels: (...args) => opencodeClient.listModels(...args),
      isAvailable: () => opencodeClient.isAvailable(),
    } satisfies AgentClient;
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients,
      registry: agentStorage,
    });
    const service = new ScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({ parent: null, unattended: true, requestedMode: undefined });
          return {
            modeId: "build",
            featureValues: { ...input.featureValues, auto_accept: true },
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

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = new ScheduleService({
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
    const service2 = new ScheduleService({
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

  test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
      (service as unknown as ScheduleServiceInternals).executeSchedule({
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
      }),
    ).rejects.toThrow("Agent archived-agent is archived");
  });

  test("defaults --every schedules to fire immediately on creation", async () => {
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const updated = await service.update({
      id: created.id,
      prompt: "second prompt",
      name: "renamed",
      cadence: { type: "every", everyMs: 5 * 60_000 },
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/new/path",
      },
    });

    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60_000 });
    expect(updated.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: "/new/path",
        model: "gpt-5",
        modeId: "full-access",
      },
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = new ScheduleService({
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

  test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
    const service = new ScheduleService({
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
      config: { provider: "codex", cwd: tempDir, modeId: "full-access" },
    });
  });

  test("runOnce rejects completed schedules", async () => {
    const service = new ScheduleService({
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

  test("deleteForAgent removes only schedules targeting that agent", async () => {
    const service = new ScheduleService({
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

    const deleted = await service.deleteForAgent(targetAgentId);
    expect(deleted).toBe(1);

    const remaining = await service.list();
    const remainingIds = remaining.map((schedule) => schedule.id).sort();
    expect(remainingIds).toEqual([otherTargeted.id, newAgentSchedule.id].sort());
    expect(remainingIds).not.toContain(targeted.id);
  });
});
