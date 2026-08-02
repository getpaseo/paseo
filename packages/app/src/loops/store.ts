import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { LoopListItem } from "@getpaseo/protocol/loop/rpc-schemas";
import { create } from "zustand";
import { selectLoopsForAgent, type LoopTrackRow } from "./select";

interface LoopState {
  /** serverId → full loop list from last refresh */
  loopsByServer: Map<string, LoopListItem[]>;
  replaceList(serverId: string, loops: LoopListItem[]): void;
}

export const useLoopStore = create<LoopState>((set) => ({
  loopsByServer: new Map(),
  replaceList(serverId, loops) {
    set((state) => {
      const next = new Map(state.loopsByServer);
      next.set(serverId, loops);
      return { loopsByServer: next };
    });
  },
}));

type LoopListClient = Pick<DaemonClient, "loopList">;

const pendingListRequests = new WeakMap<LoopListClient, Map<string, Promise<void>>>();

export function refreshLoops(client: LoopListClient, serverId: string): Promise<void> {
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(serverId);
  if (pending) return pending;

  const request = client
    .loopList()
    .then((payload) => {
      useLoopStore.getState().replaceList(serverId, payload.loops);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(serverId);
    });
  clientRequests.set(serverId, request);
  return request;
}

export function selectLoopsForAgentFromStore(
  loopsByServer: Map<string, LoopListItem[]>,
  serverId: string,
  agentId: string,
): LoopTrackRow[] {
  const loops = loopsByServer.get(serverId) ?? [];
  return selectLoopsForAgent({ agentId, loops });
}
