import { describe, expect, test, vi } from "vitest";
import type { PersistStorage, StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  createLocalProjectLinksStore,
  LocalProjectLinksPersistedStateSchema,
  type LocalProjectLinksPersistedState,
} from "./local-project-links-store";

function storageThat(write: () => Promise<void>): PersistStorage<LocalProjectLinksPersistedState> {
  return {
    getItem: () => null,
    setItem: async () => write(),
    removeItem: () => undefined,
  };
}

function storageWithPendingRead() {
  let finishRead: (value: string | null) => void = () => {
    throw new Error("pending storage read was not initialized");
  };
  let failRead: (error: Error) => void = () => {
    throw new Error("pending storage read was not initialized");
  };
  let signalReadStarted: () => void;
  const readStarted = new Promise<void>((resolve) => {
    signalReadStarted = resolve;
  });
  const read = new Promise<string | null>((resolve, reject) => {
    finishRead = resolve;
    failRead = reject;
  });
  const setItem = vi.fn(async () => undefined);
  const storage: StateStorage = {
    getItem: () => {
      signalReadStarted();
      return read;
    },
    setItem,
    removeItem: () => undefined,
  };

  return {
    storage: createValidatedPersistStorage(storage, LocalProjectLinksPersistedStateSchema),
    readStarted,
    finishRead,
    failRead,
    setItem,
  };
}

function storageWithPendingFirstWrite() {
  let failFirstWrite: (error: Error) => void = () => {
    throw new Error("pending storage write was not initialized");
  };
  const firstWrite = new Promise<void>((_resolve, reject) => {
    failFirstWrite = reject;
  });
  let writes = 0;
  const setItem = vi.fn(() => {
    writes += 1;
    return writes === 1 ? firstWrite : Promise.resolve();
  });

  return {
    storage: {
      getItem: () => null,
      setItem,
      removeItem: () => undefined,
    } satisfies PersistStorage<LocalProjectLinksPersistedState>,
    failFirstWrite,
    setItem,
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
  test("waits for hydration before applying and acknowledging a link", async () => {
    const persistedLink = {
      id: "local-existing",
      members: [
        { serverId: "host-c", projectId: "project-c" },
        { serverId: "host-d", projectId: "project-d" },
      ],
      identity: input.identity,
    };
    const pendingStorage = storageWithPendingRead();
    const store = createLocalProjectLinksStore(pendingStorage.storage);
    await pendingStorage.readStarted;

    const save = store.getState().linkProjects(input);
    const onComplete = vi.fn();
    void save.then(onComplete);

    await Promise.resolve();
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();
    expect(pendingStorage.setItem).not.toHaveBeenCalled();

    pendingStorage.finishRead(JSON.stringify({ state: { links: [persistedLink] }, version: 0 }));

    await expect(save).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(store.getState().links).toEqual([
      persistedLink,
      expect.objectContaining({
        identity: input.identity,
        members: input.members,
      }),
    ]);
    expect(pendingStorage.setItem).toHaveBeenCalledOnce();
  });

  test("rejects link mutations when initial hydration fails", async () => {
    const pendingStorage = storageWithPendingRead();
    const store = createLocalProjectLinksStore(pendingStorage.storage);
    await pendingStorage.readStarted;

    const save = store.getState().linkProjects(input);
    pendingStorage.failRead(new Error("storage unavailable"));

    await expect(save).rejects.toThrow("storage unavailable");
    expect(store.getState().links).toEqual([]);
    expect(pendingStorage.setItem).not.toHaveBeenCalled();
  });

  test("rejects a suggestion that hydration reveals would merge clones on one host", async () => {
    const persistedLink = {
      id: "local-existing",
      members: [
        { serverId: "host-a", projectId: "project-a" },
        { serverId: "host-b", projectId: "project-b-one" },
      ],
      identity: input.identity,
    };
    const pendingStorage = storageWithPendingRead();
    const store = createLocalProjectLinksStore(pendingStorage.storage);
    await pendingStorage.readStarted;

    const save = store.getState().linkProjects({
      ...input,
      members: [
        { serverId: "host-a", projectId: "project-a" },
        { serverId: "host-b", projectId: "project-b-two" },
      ],
    });
    pendingStorage.finishRead(JSON.stringify({ state: { links: [persistedLink] }, version: 0 }));

    await expect(save).rejects.toThrow("can no longer be linked");
    expect(store.getState().links).toEqual([persistedLink]);
    expect(pendingStorage.setItem).not.toHaveBeenCalled();
  });

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

  test("preserves significant whitespace in opaque project IDs", async () => {
    const members = [
      { serverId: "host-a", projectId: "remote:github.com/acme/app#subdir:web " },
      { serverId: "host-b", projectId: "project-b" },
    ];
    const persisted = {
      links: [{ id: "local-legacy", members, identity: input.identity }],
    };
    const store = createLocalProjectLinksStore(storageThat(async () => undefined));

    expect(LocalProjectLinksPersistedStateSchema.parse(persisted)).toEqual(persisted);
    await expect(store.getState().linkProjects({ ...input, members })).resolves.toBeUndefined();
    expect(store.getState().links).toEqual([
      expect.objectContaining({ identity: input.identity, members }),
    ]);
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

  test("does not roll back a later mutation when an earlier write fails", async () => {
    const pendingStorage = storageWithPendingFirstWrite();
    const store = createLocalProjectLinksStore(pendingStorage.storage);
    const first = store.getState().linkProjects(input);
    await vi.waitFor(() => expect(pendingStorage.setItem).toHaveBeenCalledOnce());

    const laterInput = {
      members: [
        { serverId: "host-c", projectId: "project-c" },
        { serverId: "host-d", projectId: "project-d" },
      ],
      identity: { repository: "github.com/acme/other", subdirectory: "" },
    };
    const later = store.getState().linkProjects(laterInput);
    expect(pendingStorage.setItem).toHaveBeenCalledOnce();

    pendingStorage.failFirstWrite(new Error("storage unavailable"));

    await expect(first).rejects.toThrow("storage unavailable");
    await expect(later).resolves.toBeUndefined();
    expect(store.getState().links).toEqual([
      expect.objectContaining({ identity: laterInput.identity, members: laterInput.members }),
    ]);
  });

  test("keeps a saved link available for retry when its removal cannot be persisted", async () => {
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

    failWrites = false;
    await expect(
      store.getState().unlinkProject({ serverId: "host-a", projectId: "project-a" }),
    ).resolves.toBeUndefined();
    expect(store.getState().links).toEqual([]);
  });
});
