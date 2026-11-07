import { describe, expect, test, vi } from "vitest";
import type { PersistStorage } from "zustand/middleware";
import {
  createLocalProjectLinksStore,
  type LocalProjectLinksPersistedState,
} from "./local-project-links-store";

function storageThat(write: () => Promise<void>): PersistStorage<LocalProjectLinksPersistedState> {
  return {
    getItem: () => null,
    setItem: async () => write(),
    removeItem: () => undefined,
  };
}

const input = {
  members: [
    { serverId: "host-a", projectId: "project-a" },
    { serverId: "host-b", projectId: "project-b" },
  ],
  identity: { repository: "github.com/acme/app", subdirectory: "" },
};

describe("local project links store", () => {
  test("waits for a local write before reporting a link complete", async () => {
    let finishWrite: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const store = createLocalProjectLinksStore(storageThat(() => pendingWrite));
    const save = store.getState().linkProjects(input);
    const onComplete = vi.fn();
    void save.then(onComplete);

    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();

    finishWrite!();
    await expect(save).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  test("exposes a local write failure to the caller", async () => {
    const store = createLocalProjectLinksStore(
      storageThat(async () => {
        throw new Error("storage unavailable");
      }),
    );

    await expect(store.getState().linkProjects(input)).rejects.toThrow("storage unavailable");
    expect(store.getState().links).toEqual([]);
  });

  test("restores a saved link when its removal cannot be persisted", async () => {
    let failWrites = false;
    const store = createLocalProjectLinksStore(
      storageThat(async () => {
        if (failWrites) throw new Error("storage unavailable");
      }),
    );
    await store.getState().linkProjects(input);
    const savedLinks = store.getState().links;
    failWrites = true;

    await expect(
      store.getState().unlinkProject({ serverId: "host-a", projectId: "project-a" }),
    ).rejects.toThrow("storage unavailable");

    expect(store.getState().links).toEqual(savedLinks);
  });
});
