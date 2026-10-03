import { create } from "zustand";
import {
  buildExplorerRevealKey,
  clearExplorerRevealRequest,
  replaceExplorerRevealRequest,
  type ExplorerRevealRequests,
} from "./reveal";

interface ExplorerRevealStoreState {
  requests: ExplorerRevealRequests;
  /** Returns the request's id, so a caller that fails to open the tree can roll it back. */
  requestReveal: (input: { serverId: string; workspaceStateKey: string; path: string }) => number;
  completeReveal: (input: { key: string; requestId: number }) => void;
}

let nextRequestId = 1;

/**
 * Pending Reveal in Files requests, one per workspace, never persisted. A request waits for a
 * visible Files tree with a loaded root and restored expanded folders, so it survives the Explorer
 * mounting after the action.
 * It ends when that tree finishes it, when the tree is hidden before finishing (abandoned: no
 * selection or scroll), when a newer request replaces it, or when it outlives
 * `EXPLORER_REVEAL_REQUEST_TTL_MS` without starting. None of these replays later.
 */
export const useExplorerRevealStore = create<ExplorerRevealStoreState>((set) => ({
  requests: {},
  requestReveal: ({ serverId, workspaceStateKey, path }) => {
    const requestId = nextRequestId++;
    const key = buildExplorerRevealKey({ serverId, workspaceStateKey });
    set((state) => ({
      requests: replaceExplorerRevealRequest(state.requests, key, {
        path,
        requestId,
        createdAt: Date.now(),
      }),
    }));
    return requestId;
  },
  completeReveal: ({ key, requestId }) => {
    set((state) => {
      const requests = clearExplorerRevealRequest(state.requests, key, requestId);
      return requests === state.requests ? state : { requests };
    });
  },
}));
