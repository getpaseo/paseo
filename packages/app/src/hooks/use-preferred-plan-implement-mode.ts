import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface PreferredPlanImplementModeState {
  modeIdByScope: Record<string, string>;
  /**
   * Storage has been read, successfully or not. Tracked here rather than through
   * `persist.hasHydrated()`, which stays false forever when the read rejects —
   * that would leave the Implement button spinning with no way to approve a plan.
   */
  hasLoaded: boolean;
  setModeId: (scope: string, modeId: string) => void;
}

export const usePreferredPlanImplementModeStore = create<PreferredPlanImplementModeState>()(
  persist(
    (set) => ({
      modeIdByScope: {},
      hasLoaded: false,
      setModeId: (scope, modeId) =>
        set((state) => ({ modeIdByScope: { ...state.modeIdByScope, [scope]: modeId } })),
    }),
    {
      name: "preferred-plan-implement-mode",
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ modeIdByScope: state.modeIdByScope }),
      // v1 held one mode for the whole install. There is no way to tell which
      // project it was meant for, so it is dropped rather than guessed onto one.
      // Present mainly so a version bump does not log a migration error.
      migrate: () => ({ modeIdByScope: {} }),
      // Runs on both the success and the failure path of the initial read.
      onRehydrateStorage: () => () => {
        usePreferredPlanImplementModeStore.setState({ hasLoaded: true });
      },
    },
  ),
);

/**
 * The permission mode this project's plans were last implemented with.
 *
 * Scoped per project rather than per install because how much rein you give an
 * agent is a property of the code it is working on: a scratch repo and a
 * production one earn different answers. A project with no answer yet starts at
 * the usual fallback rather than inheriting the last project's choice, so a
 * permissive mode picked once cannot follow you into a repo where you did not
 * want it. Build the scope with `getPlanImplementModeScope`.
 *
 * `preferredPlanImplementModeId` is `undefined` until storage has been read, so
 * callers can hold a decision instead of committing to the fallback and then
 * changing it under the user.
 */
export function usePreferredPlanImplementMode(scope: string): {
  preferredPlanImplementModeId: string | null | undefined;
  updatePreferredPlanImplementMode: (modeId: string) => void;
} {
  const modeId = usePreferredPlanImplementModeStore((state) => state.modeIdByScope[scope] ?? null);
  const hasLoaded = usePreferredPlanImplementModeStore((state) => state.hasLoaded);
  const setModeId = usePreferredPlanImplementModeStore((state) => state.setModeId);
  const updatePreferredPlanImplementMode = useCallback(
    (nextModeId: string) => setModeId(scope, nextModeId),
    [scope, setModeId],
  );
  return {
    preferredPlanImplementModeId: hasLoaded ? modeId : undefined,
    updatePreferredPlanImplementMode,
  };
}
