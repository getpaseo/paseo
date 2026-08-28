import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import {
  WorkspaceAffinityManager,
  type WorkspaceAffinityClock,
  type WorkspaceAffinityPlacement,
  workspaceAffinityId,
} from "./workspace-affinity.js";

class ManualClock implements WorkspaceAffinityClock {
  private current = new Date("2026-08-06T12:00:00.000Z");
  private readonly tasks: Array<{ at: number; cancelled: boolean; task: () => void }> = [];

  now(): Date {
    return this.current;
  }

  schedule(delayMs: number, task: () => void) {
    const scheduled = { at: this.current.getTime() + delayMs, cancelled: false, task };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  async advanceBy(delayMs: number): Promise<void> {
    this.current = new Date(this.current.getTime() + delayMs);
    while (true) {
      const due = this.tasks.find((task) => !task.cancelled && task.at <= this.current.getTime());
      if (!due) return;
      due.cancelled = true;
      due.task();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

class MemoryAgentStorage {
  readonly records: StoredAgentRecord[] = [];

  async list(): Promise<StoredAgentRecord[]> {
    return this.records;
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.records.filter((record) => record.workspaceId === workspaceId);
  }
}

let home: string | null = null;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

test("reuses and restores a hashed affinity workspace until the latest workflow deadline", async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-workspace-affinity-"));
  const clock = new ManualClock();
  const storage = new MemoryAgentStorage();
  const restored: string[] = [];
  const archived: string[] = [];
  const manager = new WorkspaceAffinityManager({
    paseoHome: home,
    daemonId: "daemon-1",
    agentStorage: storage,
    ensureWorkspace: async (workspaceId) => {
      restored.push(workspaceId);
    },
    archiveWorkspace: async (workspaceId) => {
      archived.push(workspaceId);
    },
    logger: pino({ level: "silent" }),
    clock,
  });
  const firstPlacements: WorkspaceAffinityPlacement[] = [];
  const first = await manager.create({
    affinity: {
      key: "slack-thread-1",
      retainUntil: "2026-08-06T12:01:00.000Z",
      autoArchive: true,
    },
    cwd: "/repo",
    worktree: { mode: "branch-off", newBranch: "review-thread-1" },
    create: async (placement) => {
      firstPlacements.push(placement);
      return { value: "first", workspaceId: "workspace-1", cwd: "/worktrees/review-thread-1" };
    },
  });
  expect(first).toBe("first");
  expect(firstPlacements).toEqual([
    {
      cwd: "/repo",
      worktree: { mode: "branch-off", newBranch: "review-thread-1" },
    },
  ]);

  const secondPlacements: WorkspaceAffinityPlacement[] = [];
  const second = await manager.create({
    affinity: {
      key: "slack-thread-1",
      retainUntil: "2026-08-06T12:02:00.000Z",
      autoArchive: true,
    },
    cwd: "/repo",
    worktree: { mode: "branch-off", newBranch: "review-thread-1" },
    create: async (placement) => {
      secondPlacements.push(placement);
      return { value: "second", workspaceId: "workspace-1", cwd: "/worktrees/review-thread-1" };
    },
  });
  expect(second).toBe("second");
  expect(secondPlacements).toEqual([
    { workspaceId: "workspace-1", cwd: "/worktrees/review-thread-1" },
  ]);
  expect(restored).toEqual(["workspace-1"]);

  await clock.advanceBy(60_000);
  expect(archived).toEqual([]);
  await clock.advanceBy(60_000);
  expect(archived).toEqual(["workspace-1"]);

  const persisted = await readFile(
    path.join(home, "hub-executions", "daemon-1", "workspace-affinities.json"),
    "utf8",
  );
  expect(persisted).not.toContain("slack-thread-1");
  expect(persisted).toContain(workspaceAffinityId("slack-thread-1"));
});

test("rejects target changes and never auto-archives a workspace with an unrelated live agent", async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-workspace-affinity-"));
  const clock = new ManualClock();
  const storage = new MemoryAgentStorage();
  const archived: string[] = [];
  const manager = new WorkspaceAffinityManager({
    paseoHome: home,
    daemonId: "daemon-1",
    agentStorage: storage,
    ensureWorkspace: async () => undefined,
    archiveWorkspace: async (workspaceId) => {
      archived.push(workspaceId);
    },
    logger: pino({ level: "silent" }),
    clock,
  });
  await manager.create({
    affinity: {
      key: "shared-key",
      retainUntil: "2026-08-06T12:01:00.000Z",
      autoArchive: true,
    },
    cwd: "/repo",
    create: async () => ({ value: undefined, workspaceId: "workspace-1", cwd: "/repo" }),
  });

  await expect(
    manager.create({
      affinity: {
        key: "shared-key",
        retainUntil: "2026-08-06T12:01:00.000Z",
        autoArchive: true,
      },
      cwd: "/other-repo",
      create: async () => ({ value: undefined, workspaceId: "workspace-2", cwd: "/other-repo" }),
    }),
  ).rejects.toThrow(/different cwd, worktree, or auto-archive policy/u);

  storage.records.push({
    id: "unrelated-agent",
    provider: "codex",
    cwd: "/repo",
    workspaceId: "workspace-1",
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: null,
    owner: { kind: "daemon", daemonId: "daemon-1", executionId: "other" },
  });
  await clock.advanceBy(60_000);
  expect(archived).toEqual([]);
});
