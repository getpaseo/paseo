import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const LEITSTAND_PREFERENCES_STORAGE_KEY = "leitstand-preferences";

const LeitstandPreferencesSchema = z.strictObject({
  /** Inbox item id → epoch ms until which it stays hidden. */
  snoozedUntil: z.record(z.string(), z.number()),
  /** Normalized Jira site (see `normalizeJiraSite`), null when not configured. */
  jiraSite: z.string().nullable(),
});

type LeitstandPreferences = z.infer<typeof LeitstandPreferencesSchema>;

interface LeitstandPreferencesState extends LeitstandPreferences {
  snooze: (itemId: string, untilMs: number, nowMs: number) => void;
  setJiraSite: (site: string | null) => void;
}

/** Expired snoozes carry no meaning; dropping them on write keeps the record bounded. */
function withoutExpired(snoozedUntil: Record<string, number>, nowMs: number) {
  const next: Record<string, number> = {};
  for (const [id, until] of Object.entries(snoozedUntil)) {
    if (until > nowMs) next[id] = until;
  }
  return next;
}

export const useLeitstandPreferencesStore = create<LeitstandPreferencesState>()(
  persist(
    (set) => ({
      snoozedUntil: {},
      jiraSite: null,
      snooze: (itemId, untilMs, nowMs) =>
        set((state) => ({
          snoozedUntil: { ...withoutExpired(state.snoozedUntil, nowMs), [itemId]: untilMs },
        })),
      setJiraSite: (site) => set({ jiraSite: site }),
    }),
    {
      name: LEITSTAND_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, LeitstandPreferencesSchema),
      partialize: (state) => ({ snoozedUntil: state.snoozedUntil, jiraSite: state.jiraSite }),
    },
  ),
);

/** The configured Jira site for this device, or null. Ticket keys render as plain text then. */
export function useJiraSite(): string | null {
  return useLeitstandPreferencesStore((state) => state.jiraSite);
}

export function getJiraSite(): string | null {
  return useLeitstandPreferencesStore.getState().jiraSite;
}
