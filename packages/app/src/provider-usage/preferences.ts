import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ProviderUsagePercentageDisplay } from "./types";

interface ProviderUsagePreferencesState {
  percentageDisplay: ProviderUsagePercentageDisplay;
  setPercentageDisplay: (display: ProviderUsagePercentageDisplay) => void;
}

export const useProviderUsagePreferences = create<ProviderUsagePreferencesState>()(
  persist(
    (set) => ({
      percentageDisplay: "used",
      setPercentageDisplay: (percentageDisplay) => set({ percentageDisplay }),
    }),
    {
      name: "provider-usage-preferences",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ percentageDisplay: state.percentageDisplay }),
    },
  ),
);
