import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MAX_PROMPT_HISTORY_ENTRIES = 200;

interface PromptHistoryState {
  /** Stored oldest-first; the most recently submitted prompt is the last element. */
  entries: string[];
  /**
   * Adds a prompt to the history. Trims whitespace, drops empty/whitespace-only
   * input, deduplicates by removing any prior occurrence so the latest position
   * wins, and caps the list at {@link MAX_PROMPT_HISTORY_ENTRIES}.
   */
  pushPrompt: (text: string) => void;
  clear: () => void;
}

interface PersistedPromptHistoryState {
  entries?: unknown;
}

function sanitizeEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  if (result.length > MAX_PROMPT_HISTORY_ENTRIES) {
    return result.slice(result.length - MAX_PROMPT_HISTORY_ENTRIES);
  }
  return result;
}

export const useGlobalPromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set) => ({
      entries: [],
      pushPrompt: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((state) => {
          const filtered = state.entries.filter((entry) => entry !== trimmed);
          filtered.push(trimmed);
          const overflow = filtered.length - MAX_PROMPT_HISTORY_ENTRIES;
          const next = overflow > 0 ? filtered.slice(overflow) : filtered;
          return { entries: next };
        });
      },
      clear: () => set({ entries: [] }),
    }),
    {
      name: "paseo-prompt-history",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ entries: state.entries }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as PersistedPromptHistoryState | undefined;
        const sanitized = sanitizeEntries(persisted?.entries);
        return { ...currentState, entries: sanitized };
      },
    },
  ),
);

export const PROMPT_HISTORY_MAX_ENTRIES = MAX_PROMPT_HISTORY_ENTRIES;
