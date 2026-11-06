import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToastApi, ToastShowOptions } from "@/components/toast-host";
import { clearWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedSessionHosts } from "@/test/seed-session";
import {
  archiveWorkspaceWithUndo,
  undoLatestWorkspaceArchive,
  type UndoableWorkspaceArchiveClient,
} from "@/workspace/archive-undo";

const SERVER_ID = "workspace-archive-undo-window";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workspace(id: string): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: `/repo/project/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

/** A toast host with one slot, like the app's: a new toast replaces the shown one. */
function createToastHost() {
  let shown: { content: ReactNode; options?: ToastShowOptions; dismiss: () => void } | null = null;
  const errors: string[] = [];
  const api: ToastApi = {
    show: (content, options) => {
      const previous = shown;
      const entry = {
        content,
        options,
        dismiss: () => {
          if (shown !== entry) return;
          shown = null;
          options?.onDismiss?.();
        },
      };
      shown = entry;
      previous?.options?.onDismiss?.();
      return entry.dismiss;
    },
    copied: () => {},
    error: (message) => {
      errors.push(message);
      api.show(message);
    },
  };
  return {
    api,
    errors,
    get shownTestID() {
      return shown?.options?.testID ?? null;
    },
    timeOut: () => shown?.dismiss(),
  };
}

type ArchivePayload = Awaited<ReturnType<UndoableWorkspaceArchiveClient["archiveWorkspace"]>>;

function createClient() {
  const archives = new Map<string, Deferred<ArchivePayload>>();
  const undos = new Map<string, Deferred<void>>();
  const client: UndoableWorkspaceArchiveClient = {
    archiveWorkspace: (workspaceId) => {
      const response = deferred<ArchivePayload>();
      archives.set(workspaceId, response);
      return response.promise;
    },
    undoWorkspaceArchive: (workspaceId) => {
      const response = deferred<void>();
      undos.set(workspaceId, response);
      return response.promise;
    },
  };
  return {
    client,
    finishArchive: (workspaceId: string, payload: Partial<ArchivePayload> = {}) =>
      archives.get(workspaceId)?.resolve({ error: null, ...payload }),
    undoRequested: (workspaceId: string) => undos.has(workspaceId),
    finishUndo: (workspaceId: string) => undos.get(workspaceId)?.resolve(),
    failUndo: (workspaceId: string, error: Error) => undos.get(workspaceId)?.reject(error),
  };
}

function storedWorkspace(id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[SERVER_ID]?.workspaces.get(id);
}

function startArchive(input: {
  host: ReturnType<typeof createClient>;
  toast: ReturnType<typeof createToastHost>;
  workspaceId: string;
  committed: string[];
}) {
  return archiveWorkspaceWithUndo({
    client: input.host.client,
    workspace: { serverId: SERVER_ID, workspaceId: input.workspaceId },
    toast: input.toast.api,
    onArchiveCommitted: () => input.committed.push(input.workspaceId),
  });
}

beforeEach(() => {
  seedSessionHosts([SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [workspace("a"), workspace("b")]);
});

afterEach(() => {
  undoLatestWorkspaceArchive();
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "a" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "b" });
  seedSessionHosts([]);
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceWithUndo", () => {
  it("commits the archive only once its toast is gone", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    expect(toast.shownTestID).toBe("workspace-archived-toast");
    host.finishArchive("a");
    await archive;
    expect(committed).toEqual([]);

    toast.timeOut();
    expect({ committed, undone: undoLatestWorkspaceArchive() }).toEqual({
      committed: ["a"],
      undone: false,
    });
  });

  it("keeps the layout when another client restores the workspace before the toast closes", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    host.finishArchive("a");
    await archive;
    clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "a" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [workspace("a")]);
    toast.timeOut();

    expect({ committed, row: storedWorkspace("a") }).toEqual({
      committed: [],
      row: workspace("a"),
    });
  });

  it("commits when the archive finishes after its toast already timed out", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    toast.timeOut();
    expect(committed).toEqual([]);
    host.finishArchive("a");
    await archive;

    expect(committed).toEqual(["a"]);
  });

  it("undo during a running archive brings the row back and never commits", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    expect(storedWorkspace("a")).toBeUndefined();

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect({
      row: storedWorkspace("a"),
      undoRequested: host.undoRequested("a"),
      toast: toast.shownTestID,
    }).toEqual({ row: workspace("a"), undoRequested: true, toast: null });

    host.finishArchive("a", { canceled: true, error: "Workspace archive was undone" });
    await archive;
    host.finishUndo("a");
    toast.timeOut();

    expect({ committed, errors: toast.errors, row: storedWorkspace("a") }).toEqual({
      committed: [],
      errors: [],
      row: workspace("a"),
    });
  });

  it("does not claim Cmd+Z when no archive can be undone", async () => {
    const host = createClient();
    const toast = createToastHost();

    expect(undoLatestWorkspaceArchive()).toBe(false);

    const archive = startArchive({ host, toast, workspaceId: "a", committed: [] });
    host.finishArchive("a");
    await archive;
    toast.timeOut();

    expect(undoLatestWorkspaceArchive()).toBe(false);
    expect(host.undoRequested("a")).toBe(false);
  });

  it("a newer archive takes over undo and commits the older one", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const first = startArchive({ host, toast, workspaceId: "a", committed });
    host.finishArchive("a");
    await first;
    const second = startArchive({ host, toast, workspaceId: "b", committed });
    expect(committed).toEqual(["a"]);

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect({ undoA: host.undoRequested("a"), undoB: host.undoRequested("b") }).toEqual({
      undoA: false,
      undoB: true,
    });
    host.finishArchive("b", { canceled: true });
    await second;
  });

  it("reports a failed undo and hides the row again", async () => {
    const host = createClient();
    const toast = createToastHost();

    const archive = startArchive({ host, toast, workspaceId: "a", committed: [] });
    host.finishArchive("a");
    await archive;
    undoLatestWorkspaceArchive();
    host.failUndo("a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    expect(storedWorkspace("a")).toBeUndefined();
  });

  it("stays quiet about an archive that failed after the user undid it", async () => {
    const host = createClient();
    const toast = createToastHost();

    const archive = startArchive({ host, toast, workspaceId: "a", committed: [] });
    undoLatestWorkspaceArchive();
    host.finishArchive("a", { error: "registry unavailable" });

    await expect(archive).resolves.toBeUndefined();
    expect(toast.errors).toEqual([]);
  });

  it("rejects a failed archive, closes its toast and puts the row back", async () => {
    const host = createClient();
    const toast = createToastHost();

    const archive = startArchive({ host, toast, workspaceId: "a", committed: [] });
    host.finishArchive("a", { error: "registry unavailable" });

    await expect(archive).rejects.toThrow("registry unavailable");
    expect({
      toast: toast.shownTestID,
      undone: undoLatestWorkspaceArchive(),
      row: storedWorkspace("a"),
    }).toEqual({ toast: null, undone: false, row: workspace("a") });
  });
});
