import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { isTargetPinned, togglePinnedTarget, type PinnedTabTarget } from "@/workspace-pins/target";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface PinnedTargetsState {
  pinned: PinnedTabTarget[];
  toggle: (target: PinnedTabTarget) => void;
  isPinned: (target: PinnedTabTarget) => boolean;
}

const DEFAULT_PINNED_TARGETS: PinnedTabTarget[] = [{ kind: "terminal" }, { kind: "browser" }];
const PinnedTabTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("draft") }),
  z.strictObject({ kind: z.literal("terminal") }),
  z.strictObject({ kind: z.literal("browser") }),
  z.strictObject({ kind: z.literal("profile"), profileId: z.string() }),
]);
const PinnedTargetsPersistedStateSchema = z.strictObject({
  pinned: z.array(PinnedTabTargetSchema),
});

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
  persist<PinnedTargetsState, [], [], z.infer<typeof PinnedTargetsPersistedStateSchema>>(
    (set, get) => ({
      pinned: [],
      toggle: (target) => set((state) => ({ pinned: togglePinnedTarget(state.pinned, target) })),
      isPinned: (target) => isTargetPinned(get().pinned, target),
    }),
    {
      name: "pinned-tab-targets",
      version: 1,
      merge: (persistedState, currentState) => {
        const result = PinnedTargetsPersistedStateSchema.safeParse(persistedState);
        return {
          ...currentState,
          pinned: result.success ? result.data.pinned : applyDefaultPinnedTargets([]),
        };
      },
      storage: createValidatedPersistStorage(AsyncStorage, PinnedTargetsPersistedStateSchema),
      partialize: (state) => ({ pinned: state.pinned }),
      migrate: (persistedState, version) => {
        const result = PinnedTargetsPersistedStateSchema.safeParse(persistedState);
        const pinned = result.success ? result.data.pinned : [];
        if (version === 0) {
          return { pinned: applyDefaultPinnedTargets(pinned) };
        }
        return { pinned };
      },
    },
  ),
);
