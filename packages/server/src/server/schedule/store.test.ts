import { mkdtemp, rm } from "node:fs/promises";
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
});
