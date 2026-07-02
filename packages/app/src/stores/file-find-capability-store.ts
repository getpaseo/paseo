import { create } from "zustand";

/**
 * Which workspace tabs currently show searchable file content. Chrome that
 * lives outside the pane tree (the compact tabs-row magnifier) reads this so
 * it only offers find-in-file when the pane's `file.find` handler would
 * actually open the bar — file tabs also cover rendered markdown, images,
 * binaries, and still-loading previews, none of which are searchable.
 */
interface FileFindCapabilityState {
  findableTabIds: Record<string, true>;
  setTabFindable: (tabId: string, findable: boolean) => void;
}

export const useFileFindCapabilityStore = create<FileFindCapabilityState>((set) => ({
  findableTabIds: {},
  setTabFindable: (tabId, findable) =>
    set((state) => {
      const current = state.findableTabIds[tabId] === true;
      if (current === findable) {
        return state;
      }
      const findableTabIds = { ...state.findableTabIds };
      if (findable) {
        findableTabIds[tabId] = true;
      } else {
        delete findableTabIds[tabId];
      }
      return { findableTabIds };
    }),
}));
