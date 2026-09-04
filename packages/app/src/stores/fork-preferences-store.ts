import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * How much of the source conversation a fork carries.
 *
 * `native` branches the provider's own session, so the fork resumes the real
 * upstream context and renders the real history. `summary` seeds a fresh
 * session with a curated `chat_history` attachment, which is the only option
 * when the provider cannot fork or when the fork changes provider.
 */
export type AssistantForkFidelity = "native" | "summary";

const FORK_PREFERENCES_STORAGE_KEY = "fork-preferences";
const FORK_PREFERENCES_STORE_VERSION = 1;

interface ForkPreferencesStoreState {
  fidelity: AssistantForkFidelity;
  setFidelity: (fidelity: AssistantForkFidelity) => void;
}

export const useForkPreferencesStore = create<ForkPreferencesStoreState>()(
  persist(
    (set) => ({
      fidelity: "native",
      setFidelity: (fidelity) => set({ fidelity }),
    }),
    {
      name: FORK_PREFERENCES_STORAGE_KEY,
      version: FORK_PREFERENCES_STORE_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ fidelity: state.fidelity }),
    },
  ),
);

/**
 * The fidelity a fork will actually use. A preference for `native` still
 * resolves to `summary` whenever the provider cannot branch its session or the
 * boundary is missing, so callers never have to special-case the preference.
 */
export function resolveForkFidelity(input: {
  preferred: AssistantForkFidelity;
  canForkNatively: boolean;
}): AssistantForkFidelity {
  return input.preferred === "native" && input.canForkNatively ? "native" : "summary";
}
