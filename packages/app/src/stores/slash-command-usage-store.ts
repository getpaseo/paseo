import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SlashCommandUsageState {
  usageCountsByCommand: Record<string, number>;
  recordUsage: (commandName: string) => void;
}

export const useSlashCommandUsageStore = create<SlashCommandUsageState>()(
  persist(
    (set) => ({
      usageCountsByCommand: {},
      recordUsage: (commandName) => {
        const normalized = commandName.trim();
        if (!normalized) {
          return;
        }

        set((state) => ({
          usageCountsByCommand: {
            ...state.usageCountsByCommand,
            [normalized]: (state.usageCountsByCommand[normalized] ?? 0) + 1,
          },
        }));
      },
    }),
    {
      name: "slash-command-usage",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        usageCountsByCommand: state.usageCountsByCommand,
      }),
    },
  ),
);
