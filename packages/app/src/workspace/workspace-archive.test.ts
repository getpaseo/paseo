import { seedSessionHosts } from "@/test/seed-session";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
  isWorkspaceArchiveUndoPending,
  isWorkspaceArchiveUndoRestoringAgent,
} from "@/contexts/session-workspace-upserts";
import { queryClient } from "@/data/query-client";
import { allAgentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import {
  archiveWorkspaceOptimistically,
  archiveWorkspacesOptimistically,
  beginOptimisticWorkspaceArchive,
  undoWorkspaceArchiveOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

const SERVER_ID = "workspace-archive-test";
const SECOND_SERVER_ID = "workspace-archive-test-2";

type ArchiveWorkspacePayload = Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>;

function archivePayload(input: {
  workspaceId: string;
  error?: string | null;
  canceled?: boolean;
}): ArchiveWorkspacePayload {
  return {
    requestId: "request",
    workspaceId: input.workspaceId,
    archivedAt: null,
    error: input.error ?? null,
    ...(input.canceled ? { canceled: true } : {}),
  };
}

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project/workspace-1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace-1",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

function target(input?: Partial<WorkspaceArchiveTarget>): WorkspaceArchiveTarget {
  const base = workspace();
  return {
    serverId: SERVER_ID,
    workspaceId: base.id,
    ...input,
  };
}

function createClient(
  archiveWorkspace: DaemonClient["archiveWorkspace"],
): Pick<DaemonClient, "archiveWorkspace"> {
  return { archiveWorkspace };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function storedWorkspaceOn(serverId: string, id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[serverId]?.workspaces.get(id);
}

function storedWorkspace(id: string): WorkspaceDescriptor | undefined {
  return storedWorkspaceOn(SERVER_ID, id);
}

beforeEach(() => {
  seedSessionHosts([SERVER_ID, SECOND_SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
});

afterEach(() => {
  seedSessionHosts([]);
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-2" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-2" });
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceOptimistically", () => {
  it("hides the workspace and marks the archive pending while the daemon call runs", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(vi.fn(async () => releaseArchive.promise));

    const archive = archiveWorkspaceOptimistically({
      client,
      workspace: target(),
    });

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(true);

    releaseArchive.resolve(archivePayload({ workspaceId: archived.id }));
    await archive;

    expect(storedWorkspace(archived.id)).toBeUndefined();
  });

  it("marks cached agent history stale once the host has archived the workspace", async () => {
    const historyKey = [...allAgentHistoryQueryKey([SERVER_ID]), "workspace-1"];
    queryClient.setQueryData(historyKey, { pages: [], pageParams: [] });
    const client = createClient(vi.fn(async () => archivePayload({ workspaceId: "workspace-1" })));

    await archiveWorkspaceOptimistically({ client, workspace: target() });

    expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
    queryClient.removeQueries({ queryKey: historyKey });
  });

  it("restores the workspace and clears pending state when the daemon rejects the archive", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const client = createClient(
      vi.fn(async () => archivePayload({ workspaceId: archived.id, error: "nope" })),
    );

    await expect(
      archiveWorkspaceOptimistically({
        client,
        workspace: target(),
      }),
    ).rejects.toThrow("nope");

    expect(storedWorkspace(archived.id)).toEqual(archived);
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(false);
  });
});

describe("archiveWorkspacesOptimistically", () => {
  it("returns failures and restores only the workspaces whose archive failed", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first, second]);
    const client = createClient(
      vi.fn(async (workspaceId) =>
        archivePayload({
          workspaceId,
          error: workspaceId === second.id ? "failed" : null,
        }),
      ),
    );

    const failures = await archiveWorkspacesOptimistically({
      getClient: () => client,
      workspaces: [target({ workspaceId: first.id }), target({ workspaceId: second.id })],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.workspaceId).toBe(second.id);
    expect(storedWorkspace(first.id)).toBeUndefined();
    expect(storedWorkspace(second.id)).toEqual(second);
  });

  it("archives each workspace through its own server client", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first]);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [second]);

    const archivedByServer = new Map<string, string[]>();
    const clientFor = (serverId: string) =>
      createClient(async (workspaceId) => {
        archivedByServer.set(serverId, [...(archivedByServer.get(serverId) ?? []), workspaceId]);
        return archivePayload({ workspaceId });
      });

    const failures = await archiveWorkspacesOptimistically({
      getClient: (serverId) => clientFor(serverId),
      workspaces: [
        target({
          serverId: SERVER_ID,
          workspaceId: first.id,
        }),
        target({
          serverId: SECOND_SERVER_ID,
          workspaceId: second.id,
        }),
      ],
    });

    expect(failures).toEqual([]);
    expect(archivedByServer).toEqual(
      new Map([
        [SERVER_ID, [first.id]],
        [SECOND_SERVER_ID, [second.id]],
      ]),
    );
    expect(storedWorkspaceOn(SERVER_ID, first.id)).toBeUndefined();
    expect(storedWorkspaceOn(SECOND_SERVER_ID, second.id)).toBeUndefined();
  });
});

describe("undoWorkspaceArchiveOptimistically", () => {
  it("brings the row back while the host undoes the archive it is still running", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const archiveResponse = deferred<ArchiveWorkspacePayload>();
    const undoResponse = deferred<void>();
    const archive = beginOptimisticWorkspaceArchive({
      client: createClient(async () => archiveResponse.promise),
      workspace: target(),
    });

    const undo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => undoResponse.promise },
      workspace: target(),
      hidden: archive.hidden,
    });
    expect(storedWorkspace(archived.id)).toEqual(archived);

    // The host answers the canceled archive before the undo.
    archiveResponse.resolve(archivePayload({ workspaceId: archived.id, canceled: true }));
    await expect(archive.done).resolves.toBe("canceled");
    undoResponse.resolve();
    await undo;

    expect({
      row: storedWorkspace(archived.id),
      archivePending: isWorkspaceArchivePending(target()),
      undoPending: isWorkspaceArchiveUndoPending(target()),
    }).toEqual({ row: archived, archivePending: false, undoPending: false });
  });

  it("hides the row again and clears agent restoring state when the host cannot undo the archive", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const archive = beginOptimisticWorkspaceArchive({
      client: createClient(async () => archivePayload({ workspaceId: archived.id })),
      workspace: target(),
    });
    await archive.done;

    const undoResponse = deferred<void>();
    const undo = undoWorkspaceArchiveOptimistically({
      client: {
        undoWorkspaceArchive: async () => undoResponse.promise,
      },
      workspace: target(),
      hidden: archive.hidden,
      archivedAgentIds: new Set(["agent-1"]),
    });
    expect(
      isWorkspaceArchiveUndoRestoringAgent({
        serverId: SERVER_ID,
        workspaceId: archived.id,
        agentId: "agent-1",
      }),
    ).toBe(true);

    undoResponse.reject(new Error("Branch is gone"));
    await expect(undo).rejects.toThrow("Branch is gone");

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(isWorkspaceArchiveUndoPending(target())).toBe(false);
    expect(
      isWorkspaceArchiveUndoRestoringAgent({
        serverId: SERVER_ID,
        workspaceId: archived.id,
        agentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("leaves a re-archived row hidden when the earlier undo settles", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const undoResponse = deferred<void>();
    const first = beginOptimisticWorkspaceArchive({
      client: createClient(async () => archivePayload({ workspaceId: archived.id })),
      workspace: target(),
    });
    await first.done;
    const undo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => undoResponse.promise },
      workspace: target(),
      hidden: first.hidden,
    });

    const rearchive = beginOptimisticWorkspaceArchive({
      client: createClient(async () => new Promise<ArchiveWorkspacePayload>(() => {})),
      workspace: target(),
    });
    undoResponse.resolve();
    await undo;

    expect(rearchive.hidden).toEqual(archived);
    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(isWorkspaceArchivePending(target())).toBe(true);
  });
  it("puts the row back when another client's undo cancels this archive", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const archive = beginOptimisticWorkspaceArchive({
      client: createClient(async () =>
        archivePayload({ workspaceId: archived.id, canceled: true, error: "undone" }),
      ),
      workspace: target(),
    });

    await expect(archive.done).resolves.toBe("canceled");

    expect({
      row: storedWorkspace(archived.id),
      archivePending: isWorkspaceArchivePending(target()),
    }).toEqual({ row: archived, archivePending: false });
  });

  it("an earlier undo settling keeps holding the row for a later undo", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const firstUndoResponse = deferred<void>();
    const secondUndoResponse = deferred<void>();
    const first = beginOptimisticWorkspaceArchive({
      client: createClient(async () => archivePayload({ workspaceId: archived.id })),
      workspace: target(),
    });
    await first.done;
    const firstUndo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => firstUndoResponse.promise },
      workspace: target(),
      hidden: first.hidden,
    });
    const second = beginOptimisticWorkspaceArchive({
      client: createClient(async () => new Promise<ArchiveWorkspacePayload>(() => {})),
      workspace: target(),
    });
    const secondUndo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => secondUndoResponse.promise },
      workspace: target(),
      hidden: second.hidden,
    });

    firstUndoResponse.resolve();
    await firstUndo;

    expect({
      row: storedWorkspace(archived.id),
      undoPending: isWorkspaceArchiveUndoPending(target()),
    }).toEqual({ row: archived, undoPending: true });
    secondUndoResponse.resolve();
    await secondUndo;
  });

  it("carries forward archivedAgentIds across archive -> undo -> archive -> undo while agents are still archived", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const activeAgent: Agent = {
      id: "agent-active",
      serverId: SERVER_ID,
      workspaceId: archived.id,
      title: "Active",
      provider: "claude",
      cwd: archived.workspaceDirectory,
      status: "idle",
      turn: TURN_LIVENESS_IDLE,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      lastUserMessageAt: null,
      lastActivityAt: new Date("2026-04-01T00:00:00.000Z"),
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      model: null,
      parentAgentId: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
      labels: {},
    };
    useSessionStore.getState().setAgents(SERVER_ID, new Map([[activeAgent.id, activeAgent]]));

    const firstUndoResponse = deferred<void>();
    const secondUndoResponse = deferred<void>();
    const first = beginOptimisticWorkspaceArchive({
      client: createClient(async () => archivePayload({ workspaceId: archived.id })),
      workspace: target(),
    });
    expect([...first.archivedAgentIds]).toEqual(["agent-active"]);
    await first.done;

    // Simulate the agent having been archived on the daemon before the first undo completes.
    useSessionStore.getState().setAgents(SERVER_ID, new Map());
    const firstUndo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => firstUndoResponse.promise },
      workspace: target(),
      hidden: first.hidden,
      archivedAgentIds: first.archivedAgentIds,
    });

    // Re-archive while first undo is still in flight and agents are not back in active directory yet.
    const second = beginOptimisticWorkspaceArchive({
      client: createClient(async () => new Promise<ArchiveWorkspacePayload>(() => {})),
      workspace: target(),
    });
    expect([...second.archivedAgentIds]).toEqual(["agent-active"]);

    const secondUndo = undoWorkspaceArchiveOptimistically({
      client: { undoWorkspaceArchive: async () => secondUndoResponse.promise },
      workspace: target(),
      hidden: second.hidden,
      archivedAgentIds: second.archivedAgentIds,
    });

    firstUndoResponse.resolve();
    await firstUndo;
    secondUndoResponse.resolve();
    await secondUndo;
  });
});
