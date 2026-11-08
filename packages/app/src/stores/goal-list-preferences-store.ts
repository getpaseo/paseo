import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_GOAL_SORT, GOAL_SORTS, type GoalSort } from "@/goals/goal-management";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const GoalListPreferencesPersistedSchema = z.strictObject({
  sort: z.enum(GOAL_SORTS),
});

interface GoalListPreferencesState {
  /** How the Goals screen orders goals inside each group. Per device. */
  sort: GoalSort;
  setSort: (sort: GoalSort) => void;
}

export const useGoalListPreferencesStore = create<GoalListPreferencesState>()(
  persist(
    (set) => ({
      sort: DEFAULT_GOAL_SORT,
      setSort: (sort) => set({ sort }),
    }),
    {
      name: "goal-list-preferences",
      storage: createValidatedPersistStorage(AsyncStorage, GoalListPreferencesPersistedSchema),
      partialize: (state) => ({ sort: state.sort }),
      version: 1,
    },
  ),
);
