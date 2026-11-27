import { create } from "zustand";

/**
 * "Scroll the tree to this entry", asked for from outside the tree. The tree may not be mounted
 * yet, so the request waits here until a tree shows the row and consumes it. Not persisted.
 */
interface ExplorerRevealState {
  pathByStateKey: Record<string, string>;
  request: (stateKey: string, path: string) => void;
  consume: (stateKey: string) => void;
}

export const useExplorerRevealStore = create<ExplorerRevealState>()((set) => ({
  pathByStateKey: {},
  request: (stateKey, path) =>
    set((state) => ({ pathByStateKey: { ...state.pathByStateKey, [stateKey]: path } })),
  consume: (stateKey) =>
    set((state) => {
      const { [stateKey]: _consumed, ...pathByStateKey } = state.pathByStateKey;
      return { pathByStateKey };
    }),
}));
