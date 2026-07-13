import { beforeEach, describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarProjectPreferencesStore,
  migrateSidebarProjectPreferencesState,
} from "./sidebar-project-preferences-store";

const storage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
const store = createSidebarProjectPreferencesStore(storage);

describe("sidebar project preferences", () => {
  beforeEach(() => {
    store.setState({
      pinnedProjectKeys: [],
      collections: [],
      collectionIdByProjectKey: {},
    });
  });

  it("normalizes persisted pinned project keys", () => {
    expect(
      migrateSidebarProjectPreferencesState({
        pinnedProjectKeys: [" project-b ", "", "project-a", "project-b", 42],
      }),
    ).toEqual({
      pinnedProjectKeys: ["project-b", "project-a"],
      collections: [],
      collectionIdByProjectKey: {},
    });
  });

  it("deduplicates restored project groups by identity", () => {
    expect(
      migrateSidebarProjectPreferencesState({
        collections: [
          { id: "group-a", name: "First", createdAt: "2026-07-01T00:00:00.000Z" },
          { id: "group-a", name: "Duplicate", createdAt: "2026-07-02T00:00:00.000Z" },
        ],
        collectionIdByProjectKey: { "project-a": "group-a" },
      }),
    ).toEqual({
      pinnedProjectKeys: [],
      collections: [{ id: "group-a", name: "First", createdAt: "2026-07-01T00:00:00.000Z" }],
      collectionIdByProjectKey: { "project-a": "group-a" },
    });
  });

  it("toggles project pins without disturbing the remaining order", () => {
    const preferences = store.getState();

    preferences.toggleProjectPinned("project-a");
    preferences.toggleProjectPinned("project-b");
    preferences.toggleProjectPinned("project-a");

    expect(store.getState().pinnedProjectKeys).toEqual(["project-b"]);
  });

  it("creates, assigns, renames, and deletes project collections", () => {
    const preferences = store.getState();
    const collectionId = preferences.createCollection(" Client work ");

    store.getState().assignProjectToCollection("project-a", collectionId);
    store.getState().renameCollection(collectionId, "Active clients");

    expect(store.getState()).toMatchObject({
      collections: [{ id: collectionId, name: "Active clients" }],
      collectionIdByProjectKey: { "project-a": collectionId },
    });

    store.getState().deleteCollection(collectionId);
    expect(store.getState()).toMatchObject({
      collections: [],
      collectionIdByProjectKey: {},
    });
  });
});
