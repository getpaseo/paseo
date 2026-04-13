import { create } from "zustand";

interface FileEditorStoreState {
  dirtyKeys: Set<string>;
  setDirty: (key: string, isDirty: boolean) => void;
}

export const useFileEditorStore = create<FileEditorStoreState>((set) => ({
  dirtyKeys: new Set(),
  setDirty: (key, isDirty) =>
    set((state) => {
      const next = new Set(state.dirtyKeys);
      if (isDirty) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return { dirtyKeys: next };
    }),
}));

export function makeDirtyKey(serverId: string, workspaceId: string, filePath: string): string {
  return `${serverId}:${workspaceId}:${filePath}`;
}
