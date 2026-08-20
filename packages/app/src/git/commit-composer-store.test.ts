import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  buildCommitDraftKey,
  buildSelectiveCommitFiles,
  createCommitComposerStore,
  reconcileCommitFileSelection,
  toggleAllCommitFiles,
  toggleCommitFileSelection,
} from "./commit-composer-store";

function createMemoryStorage(): StateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

describe("commit composer state", () => {
  it("normalizes trailing separators and restores independent persisted drafts", async () => {
    const storage = createMemoryStorage();
    const store = createCommitComposerStore(storage);
    await store.persist.rehydrate();

    store.getState().setDraft("/repo/feature/", "feat: selected files");
    store.getState().setDraft("/repo/other", "fix: another workspace");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const restoredStore = createCommitComposerStore(storage);
    await restoredStore.persist.rehydrate();

    expect(buildCommitDraftKey("/repo/feature/")).toBe("%2Frepo%2Ffeature");
    expect(buildCommitDraftKey("/repo/trailing-space ")).toBe("%2Frepo%2Ftrailing-space%20");
    expect(restoredStore.getState().draftsByCwd).toEqual({
      "%2Frepo%2Ffeature": "feat: selected files",
      "%2Frepo%2Fother": "fix: another workspace",
    });

    restoredStore.getState().clearDraft("/repo/feature");
    expect(restoredStore.getState().draftsByCwd).toEqual({
      "%2Frepo%2Fother": "fix: another workspace",
    });
  });

  it("selects new files by default while retaining explicit deselections", () => {
    const initial = reconcileCommitFileSelection({ knownPaths: [], selectedPaths: [] }, [
      "a.ts",
      "b.ts",
    ]);
    const deselected = {
      knownPaths: initial.knownPaths,
      selectedPaths: toggleCommitFileSelection(initial.selectedPaths, "b.ts"),
    };

    expect(reconcileCommitFileSelection(deselected, ["b.ts", "c.ts"])).toEqual({
      knownPaths: ["b.ts", "c.ts"],
      selectedPaths: ["c.ts"],
    });
    expect(toggleAllCommitFiles(["c.ts"], ["b.ts", "c.ts"])).toEqual(["b.ts", "c.ts"]);
    expect(toggleAllCommitFiles(["b.ts", "c.ts"], ["b.ts", "c.ts"])).toEqual([]);
  });

  it("includes both sides of a selected rename and de-duplicates paths", () => {
    expect(
      buildSelectiveCommitFiles(
        [
          { path: "src/renamed.ts", oldPath: "src/original.ts" },
          { path: "src/original.ts" },
          { path: "src/other.ts" },
        ],
        ["src/renamed.ts", "src/original.ts"],
      ),
    ).toEqual(["src/renamed.ts", "src/original.ts"]);
  });
});
