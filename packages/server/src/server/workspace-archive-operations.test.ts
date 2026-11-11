import { describe, expect, test } from "vitest";

import { WorkspaceArchiveOperations } from "./workspace-archive-operations.js";
import { type ArchiveResult, WorkspaceArchiveCanceledError } from "./workspace-archive-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function archived(agentIds: string[]): ArchiveResult {
  return {
    archivedAgentIds: agentIds,
    archivedWorkspaceIds: ["ws"],
    removedDirectory: false,
  };
}

/**
 * An archive that parks until released, then honours its abort signal the way archiveByScope's
 * checkpoints do: an aborted run reports the agents it already took down.
 */
function parkedArchive(agentIds: string[]) {
  const release = deferred();
  const started = deferred();
  let signal: AbortSignal | null = null;
  return {
    release: () => release.resolve(),
    started: started.promise,
    get aborted() {
      return signal?.aborted ?? false;
    },
    run: async (runSignal: AbortSignal) => {
      signal = runSignal;
      started.resolve();
      await release.promise;
      if (runSignal.aborted) throw new WorkspaceArchiveCanceledError("stamp");
      return archived(agentIds);
    },
  };
}

describe("WorkspaceArchiveOperations", () => {
  test("an undo during a running archive aborts it and restores the agents it took down", async () => {
    const operations = new WorkspaceArchiveOperations();
    const archive = parkedArchive(["agent-a", "agent-b"]);
    const restored: Array<string | undefined> = [];

    const archiveDone = operations.archive("ws", archive.run);
    await archive.started;
    const undoDone = operations.undo("ws", async ({ archivedAt }) => {
      restored.push(archivedAt);
    });

    expect(archive.aborted).toBe(true);
    expect(restored).toEqual([]);
    archive.release();

    await expect(archiveDone).resolves.toEqual({ kind: "canceled", archivedAt: "stamp" });
    await undoDone;
    expect(restored).toEqual(["stamp"]);
  });

  test("an undo after archive completion delegates restoration to persisted state", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));

    const restored: Array<string | undefined> = [];
    await operations.undo("ws", async ({ archivedAt }) => {
      restored.push(archivedAt);
    });

    expect(restored).toEqual([undefined]);
  });

  test("restore runs only after the aborted archive has stopped", async () => {
    const operations = new WorkspaceArchiveOperations();
    const archive = parkedArchive([]);
    const order: string[] = [];

    const archiveDone = operations
      .archive("ws", async (signal) => {
        try {
          return await archive.run(signal);
        } finally {
          order.push("archive stopped");
        }
      })
      .catch(() => undefined);
    await archive.started;
    const undoDone = operations.undo("ws", async () => {
      order.push("restore");
    });
    archive.release();
    await Promise.all([archiveDone, undoDone]);

    expect(order).toEqual(["archive stopped", "restore"]);
  });

  test("a second archive while one runs joins it instead of archiving twice", async () => {
    const operations = new WorkspaceArchiveOperations();
    const archive = parkedArchive(["agent-a"]);
    let runs = 0;
    const run = (signal: AbortSignal) => {
      runs += 1;
      return archive.run(signal);
    };

    const first = operations.archive("ws", run);
    const second = operations.archive("ws", run);
    archive.release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "archived", result: archived(["agent-a"]) },
      { kind: "archived", result: archived(["agent-a"]) },
    ]);
    expect(runs).toBe(1);
  });

  test("an archive requested during an undo runs after the undo, and wins", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));

    const restoreGate = deferred();
    const order: string[] = [];
    const undoDone = operations.undo("ws", async () => {
      await restoreGate.promise;
      order.push("restored");
    });
    const rearchive = operations.archive("ws", async () => {
      order.push("archived again");
      return archived(["agent-a"]);
    });

    restoreGate.resolve();
    await undoDone;
    await expect(rearchive).resolves.toMatchObject({ kind: "archived" });
    expect(order).toEqual(["restored", "archived again"]);
  });

  test("archive, undo, archive in quick succession leaves the workspace archived", async () => {
    const operations = new WorkspaceArchiveOperations();
    const first = parkedArchive(["agent-a"]);
    const restored: Array<string | undefined> = [];

    const firstDone = operations.archive("ws", first.run);
    await first.started;
    const undoDone = operations.undo("ws", async ({ archivedAt }) => {
      restored.push(archivedAt);
    });
    // The re-archive must not join the archive the undo just aborted.
    const secondDone = operations.archive("ws", async () => archived(["agent-a"]));
    first.release();

    await expect(firstDone).resolves.toEqual({ kind: "canceled", archivedAt: "stamp" });
    await undoDone;
    await expect(secondDone).resolves.toMatchObject({ kind: "archived" });
    expect(restored).toEqual(["stamp"]);
  });

  test("a second undo while one runs joins it", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));
    const restoreGate = deferred();
    let restores = 0;
    const restore = async () => {
      restores += 1;
      await restoreGate.promise;
    };

    const first = operations.undo("ws", restore);
    const second = operations.undo("ws", restore);
    restoreGate.resolve();
    await Promise.all([first, second]);

    expect(restores).toBe(1);
  });

  test("a failed restore frees the lane for retry", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));

    await expect(
      operations.undo("ws", async () => {
        throw new Error("worktree recreation failed");
      }),
    ).rejects.toThrow("worktree recreation failed");

    const restored: Array<string | undefined> = [];
    await operations.undo("ws", async ({ archivedAt }) => {
      restored.push(archivedAt);
    });
    expect(restored).toEqual([undefined]);
  });

  test("a repeat archive still delegates undo to persisted state", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));
    await operations.archive("ws", async () => ({
      archivedAgentIds: ["agent-a"],
      archivedWorkspaceIds: [],
      removedDirectory: false,
    }));
    const restored: Array<string | undefined> = [];

    await operations.undo("ws", async ({ archivedAt }) => {
      restored.push(archivedAt);
    });

    expect(restored).toEqual([undefined]);
  });

  test("each completed undo reads the current persisted state", async () => {
    const operations = new WorkspaceArchiveOperations();
    await operations.archive("ws", async () => archived(["agent-a"]));
    const restored: Array<string | undefined> = [];
    const restore = async ({ archivedAt }: { archivedAt?: string }) => {
      restored.push(archivedAt);
    };

    await operations.undo("ws", restore);
    await operations.undo("ws", restore);

    expect(restored).toEqual([undefined, undefined]);
  });

  test("a fresh daemon delegates undo to persisted workspace state", async () => {
    const operations = new WorkspaceArchiveOperations();
    const inputs: unknown[] = [];
    await operations.undo("ws", async (input) => {
      inputs.push(input);
    });
    expect(inputs).toEqual([{ archivedAt: undefined }]);
  });

  test("workspaces have independent lanes", async () => {
    const operations = new WorkspaceArchiveOperations();
    const archive = parkedArchive(["agent-a"]);

    const parked = operations.archive("ws-a", archive.run);
    await archive.started;
    await expect(operations.archive("ws-b", async () => archived(["agent-b"]))).resolves.toEqual({
      kind: "archived",
      result: archived(["agent-b"]),
    });
    await operations.undo("ws-b", async () => {});

    expect(archive.aborted).toBe(false);
    archive.release();
    await expect(parked).resolves.toMatchObject({ kind: "archived" });
  });

  test("a failed archive frees the lane for the next request", async () => {
    const operations = new WorkspaceArchiveOperations();
    await expect(
      operations.archive("ws", async () => {
        throw new Error("registry unavailable");
      }),
    ).rejects.toThrow("registry unavailable");

    await expect(operations.archive("ws", async () => archived([]))).resolves.toMatchObject({
      kind: "archived",
    });
  });
});
