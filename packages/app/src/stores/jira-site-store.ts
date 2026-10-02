import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const LEITSTAND_PREFERENCES_STORAGE_KEY = "leitstand-preferences";

const JiraSitePreferencesSchema = z.object({
  jiraSite: z.string().nullable(),
  snoozedUntil: z.record(z.string(), z.number()).default({}),
});

type JiraSitePreferences = z.infer<typeof JiraSitePreferencesSchema>;

interface JiraSitePreferencesState extends JiraSitePreferences {
  setJiraSite: (site: string | null) => void;
}

export const useJiraSiteStore = create<JiraSitePreferencesState>()(
  persist(
    (set) => ({
      jiraSite: null,
      snoozedUntil: {},
      setJiraSite: (site) => set({ jiraSite: site }),
    }),
    {
      name: LEITSTAND_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, JiraSitePreferencesSchema),
      partialize: (state) => ({ jiraSite: state.jiraSite, snoozedUntil: state.snoozedUntil }),
    },
  ),
);

export function useJiraSite(): string | null {
  return useJiraSiteStore((state) => state.jiraSite);
}

export function getJiraSite(): string | null {
  return useJiraSiteStore.getState().jiraSite;
}
