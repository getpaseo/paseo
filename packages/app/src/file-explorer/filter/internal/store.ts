import { create } from "zustand";

/** What is typed in each workspace's Files filter. Not persisted. */
interface FileFilterState {
  queryByStateKey: Record<string, string>;
  setQuery: (stateKey: string, query: string) => void;
}

export const useFileFilterStore = create<FileFilterState>()((set) => ({
  queryByStateKey: {},
  setQuery: (stateKey, query) =>
    set((state) => ({ queryByStateKey: { ...state.queryByStateKey, [stateKey]: query } })),
}));
