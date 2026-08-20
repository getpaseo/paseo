import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { usePanelStore } from "./index";

const KEY = "server::/repo";

describe("panel store diff collapse slices", () => {
  beforeEach(() => {
    usePanelStore.setState({
      diffCollapsedFoldersByWorkspace: {},
      diffCollapsedSubmodulesByWorkspace: {},
    });
  });

  it("keeps submodule collapse state out of the folder collapse map", () => {
    usePanelStore.getState().setDiffCollapsedSubmodulesForWorkspace(KEY, ["modules/demo"]);

    expect(usePanelStore.getState().diffCollapsedSubmodulesByWorkspace[KEY]).toEqual([
      "modules/demo",
    ]);
    expect(usePanelStore.getState().diffCollapsedFoldersByWorkspace[KEY]).toBeUndefined();
  });

  it("keeps folder collapse state out of the submodule collapse map", () => {
    usePanelStore.getState().setDiffCollapsedFoldersForWorkspace(KEY, ["modules/demo"]);

    expect(usePanelStore.getState().diffCollapsedFoldersByWorkspace[KEY]).toEqual(["modules/demo"]);
    expect(usePanelStore.getState().diffCollapsedSubmodulesByWorkspace[KEY]).toBeUndefined();
  });

  it("collapsing a submodule then a folder at the same path stays independent", () => {
    usePanelStore.getState().setDiffCollapsedSubmodulesForWorkspace(KEY, ["modules/demo"]);
    usePanelStore.getState().setDiffCollapsedFoldersForWorkspace(KEY, ["src/app"]);

    expect(usePanelStore.getState().diffCollapsedSubmodulesByWorkspace[KEY]).toEqual([
      "modules/demo",
    ]);
    expect(usePanelStore.getState().diffCollapsedFoldersByWorkspace[KEY]).toEqual(["src/app"]);
  });
});
