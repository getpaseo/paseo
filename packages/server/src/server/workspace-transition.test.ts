import { describe, expect, it, vi } from "vitest";

import type { ManagedAgent } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import {
  commitWorkspaceTransition,
  resolveWorkspaceTransitionBaseRef,
  WorkspaceTransitionPreservationRequiredError,
} from "./workspace-transition.js";

const SOURCE_CWD = "/repo";
const TARGET_CWD = "/worktrees/feature";

describe("workspace transition", () => {
  it("preserves workspace identity while relocating persistence and runtimes", async () => {
    const sourceWorkspace = workspace({
      workspaceId: "workspace-current",
      cwd: SOURCE_CWD,
      kind: "local_checkout",
      displayName: "repo",
    });
    const targetWorkspace = workspace({
      workspaceId: "workspace-temporary",
      cwd: TARGET_CWD,
      kind: "worktree",
      displayName: "feature/current",
      branch: "feature/current",
      worktreeRoot: TARGET_CWD,
      baseBranch: "feature/source",
      isPaseoOwnedWorktree: true,
      mainRepoRoot: SOURCE_CWD,
    });
    const liveCaller = managedAgent("agent-caller", SOURCE_CWD);
    const caller = { ...liveCaller } as ManagedAgent;
    const sibling = managedAgent("agent-sibling", SOURCE_CWD);
    const liveAgents = new Map([
      [liveCaller.id, liveCaller],
      [sibling.id, sibling],
    ]);
    const records = new Map([
      [caller.id, storedAgent(caller.id, SOURCE_CWD)],
      [sibling.id, storedAgent(sibling.id, SOURCE_CWD)],
    ]);
    const workspaces = new Map([
      [sourceWorkspace.workspaceId, sourceWorkspace],
      [targetWorkspace.workspaceId, targetWorkspace],
    ]);
    const scheduled: Array<() => void> = [];
    const closeAgent = vi.fn(async (agentId: string, options?: { persistedCwd?: string }) => {
      const live = liveAgents.get(agentId);
      const record = records.get(agentId);
      if (live && record) {
        if (options?.persistedCwd !== undefined) live.cwd = options.persistedCwd;
        records.set(agentId, { ...record, cwd: live.cwd, lastStatus: "closed" });
      }
    });
    const killWorkspaceTerminals = vi.fn(async () => undefined);
    const emitWorkspaceUpdate = vi.fn(async () => undefined);

    const transitioned = await commitWorkspaceTransition(
      {
        agentManager: { closeAgent },
        agentStorage: {
          list: async () => Array.from(records.values()),
          upsert: async (record) => {
            records.set(record.id, record);
          },
        },
        workspaceRegistry: {
          update: async (workspaceId, updater) => {
            const existing = workspaces.get(workspaceId);
            if (!existing) return null;
            const next = updater(existing);
            workspaces.set(workspaceId, next);
            return next;
          },
          upsert: async (record) => {
            workspaces.set(record.workspaceId, record);
          },
          remove: async (workspaceId) => {
            workspaces.delete(workspaceId);
          },
        },
        killWorkspaceTerminals,
        emitWorkspaceUpdate,
        logger: { warn: vi.fn() },
        schedule: (callback) => scheduled.push(callback),
      },
      {
        caller,
        liveAgents: Array.from(liveAgents.values()),
        sourceWorkspace,
        targetWorkspace,
        temporaryWorkspaceId: targetWorkspace.workspaceId,
      },
    );

    expect(transitioned).toMatchObject({
      workspaceId: sourceWorkspace.workspaceId,
      cwd: TARGET_CWD,
      kind: "worktree",
      branch: "feature/current",
    });
    expect(workspaces.get(sourceWorkspace.workspaceId)).toEqual(transitioned);
    expect(workspaces.has(targetWorkspace.workspaceId)).toBe(false);
    expect(Array.from(records.values()).map((record) => record.cwd)).toEqual([
      TARGET_CWD,
      TARGET_CWD,
    ]);
    expect(closeAgent).toHaveBeenCalledWith(sibling.id);
    expect(closeAgent).not.toHaveBeenCalledWith(caller.id);
    expect(killWorkspaceTerminals).toHaveBeenCalledWith(sourceWorkspace.workspaceId);
    expect(emitWorkspaceUpdate).toHaveBeenCalledWith(sourceWorkspace.workspaceId);
    expect(caller.cwd).toBe(SOURCE_CWD);
    expect(liveCaller.cwd).toBe(SOURCE_CWD);

    scheduled.forEach((callback) => callback());
    await vi.waitFor(() => expect(closeAgent).toHaveBeenCalledTimes(2));
    expect(closeAgent).toHaveBeenCalledWith(caller.id, { persistedCwd: TARGET_CWD });
    expect(liveCaller.cwd).toBe(TARGET_CWD);
    expect(records.get(caller.id)).toMatchObject({ cwd: TARGET_CWD, lastStatus: "closed" });
  });

  it("restores workspace and agent records when the workspace write fails", async () => {
    const sourceWorkspace = workspace({
      workspaceId: "workspace-current",
      cwd: SOURCE_CWD,
      kind: "local_checkout",
      displayName: "repo",
    });
    const targetWorkspace = workspace({
      workspaceId: "workspace-temporary",
      cwd: TARGET_CWD,
      kind: "worktree",
      displayName: "feature/current",
    });
    const caller = managedAgent("agent-caller", SOURCE_CWD);
    const sourceRecord = storedAgent(caller.id, SOURCE_CWD);
    let storedRecord = sourceRecord;
    let storedWorkspace = sourceWorkspace;

    await expect(
      commitWorkspaceTransition(
        {
          agentManager: { closeAgent: vi.fn(async () => undefined) },
          agentStorage: {
            list: async () => [storedRecord],
            upsert: async (record) => {
              storedRecord = record;
            },
          },
          workspaceRegistry: {
            update: async (_workspaceId, updater) => {
              storedWorkspace = updater(storedWorkspace);
              throw new Error("workspace persistence failed");
            },
            upsert: async (record) => {
              storedWorkspace = record;
            },
            remove: vi.fn(async () => undefined),
          },
          killWorkspaceTerminals: vi.fn(async () => undefined),
          emitWorkspaceUpdate: vi.fn(async () => undefined),
          logger: { warn: vi.fn() },
        },
        {
          caller,
          liveAgents: [caller],
          sourceWorkspace,
          targetWorkspace,
          temporaryWorkspaceId: targetWorkspace.workspaceId,
        },
      ),
    ).rejects.toThrow("workspace persistence failed");

    expect(storedWorkspace).toEqual(sourceWorkspace);
    expect(storedRecord).toEqual(sourceRecord);
    expect(caller.cwd).toBe(SOURCE_CWD);
  });

  it("requires preserving the worktree when rollback persistence fails", async () => {
    const sourceWorkspace = workspace({
      workspaceId: "workspace-current",
      cwd: SOURCE_CWD,
      kind: "local_checkout",
      displayName: "repo",
    });
    const targetWorkspace = workspace({
      workspaceId: "workspace-temporary",
      cwd: TARGET_CWD,
      kind: "worktree",
      displayName: "feature/current",
    });
    const caller = managedAgent("agent-caller", SOURCE_CWD);
    let upsertCount = 0;

    await expect(
      commitWorkspaceTransition(
        {
          agentManager: { closeAgent: vi.fn(async () => undefined) },
          agentStorage: {
            list: async () => [storedAgent(caller.id, SOURCE_CWD)],
            upsert: async () => {
              upsertCount += 1;
              if (upsertCount > 1) throw new Error("agent restore failed");
            },
          },
          workspaceRegistry: {
            update: async () => {
              throw new Error("workspace persistence failed");
            },
            upsert: async () => undefined,
            remove: vi.fn(async () => undefined),
          },
          killWorkspaceTerminals: vi.fn(async () => undefined),
          emitWorkspaceUpdate: vi.fn(async () => undefined),
          logger: { warn: vi.fn() },
        },
        {
          caller,
          liveAgents: [caller],
          sourceWorkspace,
          targetWorkspace,
          temporaryWorkspaceId: targetWorkspace.workspaceId,
        },
      ),
    ).rejects.toBeInstanceOf(WorkspaceTransitionPreservationRequiredError);
  });

  it("bases the worktree on the current checkout unless explicitly overridden", () => {
    expect(resolveWorkspaceTransitionBaseRef({ currentBranch: "feature/source" })).toBe(
      "feature/source",
    );
    expect(
      resolveWorkspaceTransitionBaseRef({
        requestedBaseBranch: "main",
        currentBranch: "feature/source",
      }),
    ).toBe("main");
    expect(resolveWorkspaceTransitionBaseRef({ currentBranch: null })).toBe("HEAD");
  });
});

function workspace(
  overrides: Partial<PersistedWorkspaceRecord> &
    Pick<PersistedWorkspaceRecord, "workspaceId" | "cwd" | "kind" | "displayName">,
): PersistedWorkspaceRecord {
  return {
    projectId: "project-current",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    ...overrides,
  };
}

function storedAgent(id: string, cwd: string): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd,
    workspaceId: "workspace-current",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    labels: {},
    lastStatus: "idle",
  };
}

function managedAgent(id: string, cwd: string): ManagedAgent {
  return {
    id,
    cwd,
    workspaceId: "workspace-current",
    lifecycle: "idle",
  } as ManagedAgent;
}
