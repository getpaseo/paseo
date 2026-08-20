import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const STORE_NAME = "@paseo:commit-composer-store";
const STORE_VERSION = 1;

const CommitComposerPersistedStateSchema = z.strictObject({
  draftsByCwd: z.record(z.string(), z.string()),
});

interface CommitComposerStoreState {
  draftsByCwd: Record<string, string>;
  setDraft: (cwd: string, message: string) => void;
  clearDraft: (cwd: string) => void;
}

export interface CommitFileSelectionState {
  knownPaths: string[];
  selectedPaths: string[];
}

export function buildCommitDraftKey(cwd: string): string {
  const normalized = cwd === "/" ? cwd : cwd.replace(/\/+$/, "");
  return encodeURIComponent(normalized);
}

export function createCommitComposerStore(storage: StateStorage) {
  return create<CommitComposerStoreState>()(
    persist<CommitComposerStoreState, [], [], z.infer<typeof CommitComposerPersistedStateSchema>>(
      (set) => ({
        draftsByCwd: {},
        setDraft: (cwd, message) => {
          const key = buildCommitDraftKey(cwd);
          set((state) => {
            if (!message) {
              const { [key]: _removed, ...draftsByCwd } = state.draftsByCwd;
              return { draftsByCwd };
            }
            return { draftsByCwd: { ...state.draftsByCwd, [key]: message } };
          });
        },
        clearDraft: (cwd) => {
          const key = buildCommitDraftKey(cwd);
          set((state) => {
            const { [key]: _removed, ...draftsByCwd } = state.draftsByCwd;
            return { draftsByCwd };
          });
        },
      }),
      {
        name: STORE_NAME,
        version: STORE_VERSION,
        storage: createValidatedPersistStorage(storage, CommitComposerPersistedStateSchema),
        partialize: (state) => ({ draftsByCwd: state.draftsByCwd }),
        merge: (persistedState, currentState) => {
          const result = CommitComposerPersistedStateSchema.safeParse(persistedState);
          return {
            ...currentState,
            draftsByCwd: result.success ? result.data.draftsByCwd : {},
          };
        },
      },
    ),
  );
}

export const useCommitComposerStore = createCommitComposerStore(AsyncStorage);

export function reconcileCommitFileSelection(
  previous: CommitFileSelectionState,
  nextPaths: readonly string[],
): CommitFileSelectionState {
  const known = new Set(previous.knownPaths);
  const selected = new Set(previous.selectedPaths);
  const selectedPaths = nextPaths.filter((path) => !known.has(path) || selected.has(path));
  return { knownPaths: [...nextPaths], selectedPaths };
}

export function toggleCommitFileSelection(
  selectedPaths: readonly string[],
  path: string,
): string[] {
  const selected = new Set(selectedPaths);
  if (selected.has(path)) {
    selected.delete(path);
  } else {
    selected.add(path);
  }
  return [...selected];
}

export function toggleAllCommitFiles(
  selectedPaths: readonly string[],
  availablePaths: readonly string[],
): string[] {
  const selected = new Set(selectedPaths);
  return availablePaths.every((path) => selected.has(path)) ? [] : [...availablePaths];
}

export function buildSelectiveCommitFiles(
  files: readonly Pick<ParsedDiffFile, "path" | "oldPath">[],
  selectedPaths: readonly string[],
): string[] {
  const selected = new Set(selectedPaths);
  const commitPaths = new Set<string>();
  for (const file of files) {
    if (!selected.has(file.path)) {
      continue;
    }
    commitPaths.add(file.path);
    if (file.oldPath) {
      commitPaths.add(file.oldPath);
    }
  }
  return [...commitPaths];
}
