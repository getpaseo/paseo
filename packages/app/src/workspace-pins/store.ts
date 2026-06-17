import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isTargetPinned, togglePinnedTarget, type PinnedTabTarget } from "@/workspace-pins/target";

interface PinnedTargetsState {
  pinned: PinnedTabTarget[];
  toggle: (target: PinnedTabTarget) => void;
  isPinned: (target: PinnedTabTarget) => boolean;
}

const DEFAULT_PINNED_TARGETS: PinnedTabTarget[] = [{ kind: "terminal" }, { kind: "browser" }];

function applyDefaultPinnedTargets(pinned: PinnedTabTarget[]): PinnedTabTarget[] {
  const next = [...DEFAULT_PINNED_TARGETS];
  for (const target of pinned) {
    if (!isTargetPinned(next, target)) {
      next.push(target);
    }
  }
  return next;
}

export const usePinnedTargetsStore = create<PinnedTargetsState>()(
  persist(
    (set, get) => ({
      pinned: [],
      toggle: (target) => set((state) => ({ pinned: togglePinnedTarget(state.pinned, target) })),
      isPinned: (target) => isTargetPinned(get().pinned, target),
    }),
    {
      name: "pinned-tab-targets",
      version: 1,
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PinnedTargetsState> | null;
        return {
          ...currentState,
          ...persisted,
          pinned: persisted?.pinned ?? applyDefaultPinnedTargets([]),
        };
      },
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ pinned: state.pinned }),
      migrate: (persistedState, version) => {
        if (version === 0) {
          const pinned = (persistedState as { pinned?: PinnedTabTarget[] } | null)?.pinned ?? [];
          return { pinned: applyDefaultPinnedTargets(pinned) };
        }
        return persistedState as PinnedTargetsState;
      },
    },
  ),
);
