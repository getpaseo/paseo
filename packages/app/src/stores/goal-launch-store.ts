import { create } from "zustand";
import type { GoalFormPrefill } from "@/goals/goal-form-model";

interface GoalLaunchRequest {
  serverId: string;
  prefill: GoalFormPrefill;
  /** Distinguishes two opens with equal values so each mounts a fresh form. */
  openId: number;
}

interface GoalLaunchStoreState {
  request: GoalLaunchRequest | null;
  open: (input: { serverId: string; prefill: GoalFormPrefill }) => void;
  close: () => void;
}

let nextOpenId = 1;

/** Opens the goal form from outside the Goals screen, such as from a chat. */
export const useGoalLaunchStore = create<GoalLaunchStoreState>()((set) => ({
  request: null,
  open: ({ serverId, prefill }) => {
    nextOpenId += 1;
    set({ request: { serverId, prefill, openId: nextOpenId } });
  },
  close: () => {
    set({ request: null });
  },
}));
