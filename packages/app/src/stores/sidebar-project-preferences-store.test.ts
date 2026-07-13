import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  migrateSidebarProjectPreferencesState,
  useSidebarProjectPreferencesStore,
} from "./sidebar-project-preferences-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("sidebar project preferences", () => {
  beforeEach(() => {
    useSidebarProjectPreferencesStore.setState({
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
    const store = useSidebarProjectPreferencesStore.getState();

    store.toggleProjectPinned("project-a");
    store.toggleProjectPinned("project-b");
    store.toggleProjectPinned("project-a");

    expect(useSidebarProjectPreferencesStore.getState().pinnedProjectKeys).toEqual(["project-b"]);
  });

  it("creates, assigns, renames, and deletes project collections", () => {
    const store = useSidebarProjectPreferencesStore.getState();
    const collectionId = store.createCollection(" Client work ");

    useSidebarProjectPreferencesStore
      .getState()
      .assignProjectToCollection("project-a", collectionId);
    useSidebarProjectPreferencesStore.getState().renameCollection(collectionId, "Active clients");

    expect(useSidebarProjectPreferencesStore.getState()).toMatchObject({
      collections: [{ id: collectionId, name: "Active clients" }],
      collectionIdByProjectKey: { "project-a": collectionId },
    });

    useSidebarProjectPreferencesStore.getState().deleteCollection(collectionId);
    expect(useSidebarProjectPreferencesStore.getState()).toMatchObject({
      collections: [],
      collectionIdByProjectKey: {},
    });
  });
});
