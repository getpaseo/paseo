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

  test("put round-trips an updated schedule to disk", async () => {
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
    await store.put(updated);

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
});
