import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ScheduleService } from "./service.js";

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
    await rm(tempDir, { recursive: true, force: true });
  });

  test("ticks due schedules and records run history on disk", async () => {
    const service = new ScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
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

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = new ScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
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
      (service as any).executeSchedule({
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
});
