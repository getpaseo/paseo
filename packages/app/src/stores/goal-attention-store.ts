import { create } from "zustand";

interface GoalAttentionStoreState {
  /** Goals blocked on your approval, per host, from the latest list. */
  blockedByServer: Record<string, number>;
  /** Hosts whose `goal.update` push subscription is live; their lists poll slowly. */
  pushLiveByServer: Record<string, true>;
  setBlocked: (serverId: string, count: number) => void;
  setPushLive: (serverId: string, live: boolean) => void;
  clear: (serverId: string) => void;
}

/** Written by `GoalAttentionWatcher`, read by the sidebar's Goals badge and the goal queries. */
export const useGoalAttentionStore = create<GoalAttentionStoreState>()((set) => ({
  blockedByServer: {},
  pushLiveByServer: {},
  setBlocked: (serverId, count) => {
    set((state) =>
      state.blockedByServer[serverId] === count
        ? state
        : { blockedByServer: { ...state.blockedByServer, [serverId]: count } },
    );
  },
  setPushLive: (serverId, live) => {
    set((state) => {
      if (Boolean(state.pushLiveByServer[serverId]) === live) {
        return state;
      }
      const { [serverId]: _previous, ...rest } = state.pushLiveByServer;
      return { pushLiveByServer: live ? { ...rest, [serverId]: true } : rest };
    });
  },
  clear: (serverId) => {
    set((state) => {
      if (!(serverId in state.blockedByServer) && !(serverId in state.pushLiveByServer)) {
        return state;
      }
      const { [serverId]: _removed, ...rest } = state.blockedByServer;
      const { [serverId]: _live, ...liveRest } = state.pushLiveByServer;
      return { blockedByServer: rest, pushLiveByServer: liveRest };
    });
  },
}));

export function selectTotalBlockedGoals(state: GoalAttentionStoreState): number {
  return Object.values(state.blockedByServer).reduce((sum, count) => sum + count, 0);
}

export function useGoalPushLive(serverId: string): boolean {
  return useGoalAttentionStore((state) => state.pushLiveByServer[serverId] === true);
}
