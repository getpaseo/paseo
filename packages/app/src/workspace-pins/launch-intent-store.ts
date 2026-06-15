import { create } from "zustand";
import type { PinnedTabTarget } from "@/workspace-pins/target";

export interface PendingTabLaunch {
  workspaceKey: string;
  target: PinnedTabTarget;
}

interface LaunchIntentState {
  pending: PendingTabLaunch | null;
  request: (intent: PendingTabLaunch) => void;
  consume: (workspaceKey: string) => PinnedTabTarget | null;
}

export const useLaunchIntentStore = create<LaunchIntentState>((set, get) => ({
  pending: null,
  request: (intent) => set({ pending: intent }),
  consume: (workspaceKey) => {
    const { pending } = get();
    if (!pending || pending.workspaceKey !== workspaceKey) {
      return null;
    }
    set({ pending: null });
    return pending.target;
  },
}));
