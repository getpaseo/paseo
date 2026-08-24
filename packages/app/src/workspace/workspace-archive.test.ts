import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  archiveWorkspaceOptimistically,
  archiveWorkspacesOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

const SERVER_ID = "workspace-archive-test";
const SECOND_SERVER_ID = "workspace-archive-test-2";

type ArchiveWorkspacePayload = Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>;

function archivePayload(input: {
  workspaceId: string;
  error?: string | null;
}): ArchiveWorkspacePayload {
  return {
    requestId: "request",
    workspaceId: input.workspaceId,
    archivedAt: null,
    error: input.error ?? null,
  };
}

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
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
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
});

afterEach(() => {
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-2" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-2" });
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceOptimistically", () => {
  it("hides the workspace and marks the archive pending while the daemon call runs", async () => {
    const archived = workspace();
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [archived]);
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

  it("restores the workspace and clears pending state when the daemon rejects the archive", async () => {
    const archived = workspace();
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [archived]);
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
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [first, second]);
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
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [first]);
    useSessionStore.getState().mergeWorkspaces(SECOND_SERVER_ID, [second]);

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
