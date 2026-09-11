import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ScheduleStore } from "./store.js";

describe("ScheduleStore", () => {
  let tempDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-store-test-"));
    store = new ScheduleStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates and reloads schedules from disk", async () => {
    const created = await store.create({
      name: "Morning summary",
      prompt: "Summarize new commits",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    const reloaded = new ScheduleStore(tempDir);
    const listed = await reloaded.list();

    expect(created.id).toHaveLength(8);
    expect(listed).toEqual([created]);
  });

  test("update round-trips an updated schedule to disk", async () => {
    const created = await store.create({
      name: "before",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    const updated = {
      ...created,
      name: "after",
      prompt: "after",
      cadence: { type: "cron" as const, expression: "0 9 * * *" },
      target: {
        type: "new-agent" as const,
        config: { provider: "codex", cwd: "/elsewhere", modeId: "full-access" },
      },
      nextRunAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T00:00:30.000Z",
    };
    await store.update(created.id, () => updated);

    const reloaded = await new ScheduleStore(tempDir).get(created.id);
    expect(reloaded).toEqual(updated);
  });

  test("deletes schedules from disk", async () => {
    const created = await store.create({
      name: null,
      prompt: "Check status",
      cadence: { type: "every", everyMs: 30_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:00:30.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test("serializes concurrent updates on one schedule without losing writes", async () => {
    const created = await store.create({
      name: "before",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    let releaseFirstUpdate: (() => void) | null = null;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let firstUpdaterEntered: (() => void) | null = null;
    const firstUpdaterStarted = new Promise<void>((resolve) => {
      firstUpdaterEntered = resolve;
    });
    let secondSawRunCount = -1;

    const firstUpdate = store.update(created.id, async (schedule) => {
      firstUpdaterEntered?.();
      await firstUpdateBlocked;
      return {
        ...schedule,
        runs: [
          ...schedule.runs,
          {
            id: "run-1",
            scheduledFor: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            endedAt: null,
            status: "running" as const,
            agentId: null,
            output: null,
            error: null,
          },
        ],
      };
    });
    await firstUpdaterStarted;

    const secondUpdate = store.update(created.id, (schedule) => {
      secondSawRunCount = schedule.runs.length;
      return {
        ...schedule,
        prompt: "after",
      };
    });

    releaseFirstUpdate?.();
    const [, second] = await Promise.all([firstUpdate, secondUpdate]);

    expect(secondSawRunCount).toBe(1);
    expect(second).toMatchObject({
      prompt: "after",
      runs: [{ id: "run-1" }],
    });
    await expect(new ScheduleStore(tempDir).get(created.id)).resolves.toMatchObject({
      prompt: "after",
      runs: [{ id: "run-1" }],
    });
  });

  test("revalidates a named target match after waiting for the schedule update queue", async () => {
    class GatedListScheduleStore extends ScheduleStore {
      private listGate: {
        entered: () => void;
        release: Promise<void>;
      } | null = null;

      gateNextList(gate: { entered: () => void; release: Promise<void> }): void {
        this.listGate = gate;
      }

      override async list() {
        const schedules = await super.list();
        const gate = this.listGate;
        if (gate) {
          this.listGate = null;
          gate.entered();
          await gate.release;
        }
        return schedules;
      }
    }

    const gatedStore = new GatedListScheduleStore(tempDir);
    const target = {
      type: "new-agent" as const,
      config: { provider: "claude" as const, cwd: tempDir },
    };
    const created = await gatedStore.create({
      name: "race",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    let releaseCompletion: (() => void) | null = null;
    const completionBlocked = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let completionEntered: (() => void) | null = null;
    const completionStarted = new Promise<void>((resolve) => {
      completionEntered = resolve;
    });
    const completeOriginal = gatedStore.update(created.id, async (schedule) => {
      completionEntered?.();
      await completionBlocked;
      return {
        ...schedule,
        status: "completed" as const,
        nextRunAt: null,
        updatedAt: "2026-01-01T00:00:30.000Z",
      };
    });
    await completionStarted;

    let releaseUpsertList: (() => void) | null = null;
    const upsertListBlocked = new Promise<void>((resolve) => {
      releaseUpsertList = resolve;
    });
    let upsertListEntered: (() => void) | null = null;
    const upsertListed = new Promise<void>((resolve) => {
      upsertListEntered = resolve;
    });
    gatedStore.gateNextList({
      entered: () => upsertListEntered?.(),
      release: upsertListBlocked,
    });

    const upsert = gatedStore.upsertByNameAndTarget("race", target, {
      create: () => ({
        name: "race",
        prompt: "after",
        cadence: { type: "every", everyMs: 60_000 },
        target,
        status: "active",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        nextRunAt: "2026-01-01T00:02:00.000Z",
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
        runs: [],
      }),
      update: () => {
        throw new Error("stale identity match should not update");
      },
    });

    await upsertListed;
    releaseCompletion?.();
    await completeOriginal;
    releaseUpsertList?.();

    const upserted = await upsert;
    expect(upserted.id).not.toBe(created.id);
    expect(upserted).toMatchObject({
      name: "race",
      prompt: "after",
      status: "active",
    });
    await expect(gatedStore.get(created.id)).resolves.toMatchObject({
      status: "completed",
      prompt: "before",
    });
    expect(await gatedStore.list()).toHaveLength(2);
  });

  test("restores exact schedule state after recreating the store", async () => {
    const created = await store.create({
      name: "exact restore",
      prompt: "check",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:00:37.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    const transitioned = await store.transitionState(
      { operationId: "operation-exact", scheduleId: created.id, targetStatus: "paused" },
      (schedule) => ({
        ...schedule,
        status: "paused",
        pausedAt: "2026-01-01T00:00:10.000Z",
        nextRunAt: null,
        updatedAt: "2026-01-01T00:00:10.000Z",
      }),
    );
    expect(transitioned).toMatchObject({ replayed: false, isCurrent: true });

    const reloaded = new ScheduleStore(tempDir);
    const restored = await reloaded.restoreState(
      { operationId: "operation-exact", scheduleId: created.id },
      (schedule, state) => ({ ...schedule, ...state }),
    );
    expect(restored).toMatchObject({ replayed: false, isCurrent: true });
    expect(restored.schedule).toMatchObject({
      status: "active",
      pausedAt: null,
      nextRunAt: "2026-01-01T00:00:37.000Z",
    });

    const replay = await reloaded.restoreState(
      { operationId: "operation-exact", scheduleId: created.id },
      (schedule, state) => ({ ...schedule, ...state }),
    );
    expect(replay).toMatchObject({ replayed: true, isCurrent: true });
    expect(replay.schedule).toEqual(restored.schedule);
  });

  test("recovers prepared transitions at either durable-write boundary", async () => {
    const createActive = () =>
      store.create({
        name: null,
        prompt: "check",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent" as const, config: { provider: "claude", cwd: tempDir } },
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-01T00:01:00.000Z",
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
        runs: [],
      });
    const pause = (schedule: Awaited<ReturnType<typeof createActive>>) => ({
      ...schedule,
      status: "paused" as const,
      pausedAt: "2026-01-01T00:00:10.000Z",
      nextRunAt: null,
    });

    const beforeWrite = await createActive();
    const crashBeforeWrite = new ScheduleStore(tempDir, {
      afterOperationPrepared: () => {
        throw new Error("crash after prepared");
      },
    });
    await expect(
      crashBeforeWrite.transitionState(
        { operationId: "crash-before-write", scheduleId: beforeWrite.id, targetStatus: "paused" },
        pause,
      ),
    ).rejects.toThrow("crash after prepared");
    const recoveredBeforeWrite = await new ScheduleStore(tempDir).transitionState(
      { operationId: "crash-before-write", scheduleId: beforeWrite.id, targetStatus: "paused" },
      pause,
    );
    expect(recoveredBeforeWrite).toMatchObject({ replayed: true, isCurrent: true });
    expect(recoveredBeforeWrite.schedule.status).toBe("paused");

    const afterWrite = await createActive();
    const crashAfterWrite = new ScheduleStore(tempDir, {
      afterScheduleWritten: () => {
        throw new Error("crash after schedule write");
      },
    });
    await expect(
      crashAfterWrite.transitionState(
        { operationId: "crash-after-write", scheduleId: afterWrite.id, targetStatus: "paused" },
        pause,
      ),
    ).rejects.toThrow("crash after schedule write");
    const recoveredAfterWrite = await new ScheduleStore(tempDir).transitionState(
      { operationId: "crash-after-write", scheduleId: afterWrite.id, targetStatus: "paused" },
      pause,
    );
    expect(recoveredAfterWrite).toMatchObject({ replayed: true, isCurrent: true });
    expect(recoveredAfterWrite.schedule.status).toBe("paused");

    const conflicted = await createActive();
    const crashPrepared = new ScheduleStore(tempDir, {
      afterOperationPrepared: () => {
        throw new Error("crash before conflicting write");
      },
    });
    await expect(
      crashPrepared.transitionState(
        { operationId: "crash-then-conflict", scheduleId: conflicted.id, targetStatus: "paused" },
        pause,
      ),
    ).rejects.toThrow("crash before conflicting write");
    await new ScheduleStore(tempDir).update(conflicted.id, (schedule) => ({
      ...schedule,
      prompt: "changed outside the operation",
    }));
    await expect(
      new ScheduleStore(tempDir).transitionState(
        { operationId: "crash-then-conflict", scheduleId: conflicted.id, targetStatus: "paused" },
        pause,
      ),
    ).rejects.toThrow("no longer matches prepared operation");
  });

  test("rejects reuse, foreign restore, and ABA after a transition", async () => {
    const created = await store.create({
      name: null,
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const input = {
      operationId: "operation-owned",
      scheduleId: created.id,
      targetStatus: "paused" as const,
    };
    const pause = (schedule: typeof created) => ({
      ...schedule,
      status: "paused" as const,
      pausedAt: "2026-01-01T00:00:10.000Z",
      nextRunAt: null,
    });
    await store.transitionState(input, pause);

    await expect(
      store.transitionState({ ...input, targetStatus: "active" }, (schedule) => schedule),
    ).rejects.toThrow("operation id already used");
    await expect(
      store.restoreState(
        { operationId: input.operationId, scheduleId: "foreign-schedule" },
        (schedule, state) => ({ ...schedule, ...state }),
      ),
    ).rejects.toThrow("belongs to another schedule");

    await store.transitionState(
      { operationId: "other-operation", scheduleId: created.id, targetStatus: "active" },
      (schedule) => ({
        ...schedule,
        status: "active",
        pausedAt: null,
        nextRunAt: "2026-01-01T00:02:00.000Z",
      }),
    );
    await store.restoreState(
      { operationId: "other-operation", scheduleId: created.id },
      (schedule, state) => ({ ...schedule, ...state }),
    );
    const replay = await store.transitionState(input, pause);
    expect(replay).toMatchObject({ replayed: true, isCurrent: false });
    await expect(
      store.restoreState(input, (schedule, state) => ({ ...schedule, ...state })),
    ).rejects.toThrow("changed after operation");
  });

  test("recovers an interrupted restore and rejects a recreated schedule id", async () => {
    const created = await store.create({
      name: null,
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const input = {
      operationId: "restore-crash",
      scheduleId: created.id,
      targetStatus: "paused" as const,
    };
    await store.transitionState(input, (schedule) => ({
      ...schedule,
      status: "paused",
      pausedAt: "2026-01-01T00:00:10.000Z",
      nextRunAt: null,
    }));
    const crashDuringRestore = new ScheduleStore(tempDir, {
      afterRestoreScheduleWritten: () => {
        throw new Error("crash after restore schedule write");
      },
    });
    await expect(
      crashDuringRestore.restoreState(input, (schedule, state) => ({ ...schedule, ...state })),
    ).rejects.toThrow("crash after restore schedule write");
    const recovered = await new ScheduleStore(tempDir).restoreState(input, (schedule, state) => ({
      ...schedule,
      ...state,
    }));
    expect(recovered).toMatchObject({ replayed: true, isCurrent: true });
    expect(recovered.schedule).toMatchObject({
      status: "active",
      pausedAt: null,
      nextRunAt: "2026-01-01T00:01:00.000Z",
    });

    const recreated = await store.create({
      ...created,
      name: "recreated",
    });
    const recreateInput = {
      operationId: "recreated-id",
      scheduleId: recreated.id,
      targetStatus: "paused" as const,
    };
    await store.transitionState(recreateInput, (schedule) => ({
      ...schedule,
      status: "paused",
      pausedAt: "2026-01-01T00:00:20.000Z",
      nextRunAt: null,
    }));
    await store.delete(recreated.id);
    await writeFile(join(tempDir, `${recreated.id}.json`), JSON.stringify(recreated), "utf-8");
    await expect(
      new ScheduleStore(tempDir).restoreState(recreateInput, (schedule, state) => ({
        ...schedule,
        ...state,
      })),
    ).rejects.toThrow("changed after operation");
  });
});
