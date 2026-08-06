import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

const STORAGE_KEY = "@paseo:shortcut-mod-preference";

/**
 * Which physical key acts as the shortcut modifier ("Mod"). "auto" follows the
 * platform (Cmd on Apple, Ctrl elsewhere); "cmd" forces Cmd/Win/Super; "ctrl"
 * forces Control. Resolved through getShortcutOs, so it also selects between
 * the mac / non-mac binding variants and the ⌘ / Ctrl display style.
 */
export type ShortcutModPreference = "auto" | "cmd" | "ctrl";

interface ShortcutModState {
  preference: ShortcutModPreference;
  setPreference: (preference: ShortcutModPreference) => void;
}

let preferenceSetThisSession = false;

export const useShortcutModStore = create<ShortcutModState>((set) => ({
  preference: "auto",
  setPreference: (preference) => {
    preferenceSetThisSession = true;
    set({ preference });
    void AsyncStorage.setItem(STORAGE_KEY, preference);
  },
}));

async function hydratePreference() {
  const value = await AsyncStorage.getItem(STORAGE_KEY);
  // A selection made before this read resolves wins over the persisted value.
  if (preferenceSetThisSession) {
    return;
  }
  if (value === "cmd" || value === "ctrl") {
    useShortcutModStore.setState({ preference: value });
  }
}
void hydratePreference();

export function getShortcutModPreference(): ShortcutModPreference {
  return useShortcutModStore.getState().preference;
}
