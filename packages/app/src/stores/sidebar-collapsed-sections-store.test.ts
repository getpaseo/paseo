import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

describe("sidebar-collapsed-sections-store", () => {
  beforeEach(() => {
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
    });
  });

  it("tracks collapsed project keys as a Set", () => {
    const store = useSidebarCollapsedSectionsStore.getState();

    store.setProjectCollapsed("project-a", true);
    store.toggleProjectCollapsed("project-b");
    store.toggleProjectCollapsed("project-a");

    expect(Array.from(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys)).toEqual([
      "project-b",
    ]);
  });

  it("serializes collapsed project keys for preference storage", () => {
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
    });

    const partialize = useSidebarCollapsedSectionsStore.persist.getOptions().partialize;

    expect(partialize?.(useSidebarCollapsedSectionsStore.getState())).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
    });
  });

  it("restores collapsed project keys from persisted preferences", () => {
    const merge = useSidebarCollapsedSectionsStore.persist.getOptions().merge;
    const restored = merge?.(
      {
        collapsedProjectKeys: ["project-a", "project-b", 42],
      },
      useSidebarCollapsedSectionsStore.getState(),
    );

    expect(Array.from(restored?.collapsedProjectKeys ?? [])).toEqual(["project-a", "project-b"]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const merge = useSidebarCollapsedSectionsStore.persist.getOptions().merge;
    const currentState = useSidebarCollapsedSectionsStore.getState();

    expect(merge?.({}, currentState)).toBe(currentState);
    expect(merge?.({ collapsedProjectKeys: [] }, currentState)).toBe(currentState);
  });
});
