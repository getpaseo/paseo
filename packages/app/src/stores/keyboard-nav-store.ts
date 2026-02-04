import { create } from "zustand";

interface KeyboardNavState {
  commandCenterOpen: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  /** Sidebar-visible agent keys (up to 9), in top-to-bottom visual order. */
  sidebarShortcutAgentKeys: string[];
  focusChatInputRequest: { id: number; agentKey: string | null } | null;

  setCommandCenterOpen: (open: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setSidebarShortcutAgentKeys: (keys: string[]) => void;
  requestFocusChatInput: (agentKey: string | null) => void;
  clearFocusChatInputRequest: (id: number) => void;
  resetModifiers: () => void;
}

export const useKeyboardNavStore = create<KeyboardNavState>((set) => ({
  commandCenterOpen: false,
  altDown: false,
  cmdOrCtrlDown: false,
  sidebarShortcutAgentKeys: [],
  focusChatInputRequest: null,

  setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
  setAltDown: (down) => set({ altDown: down }),
  setCmdOrCtrlDown: (down) => set({ cmdOrCtrlDown: down }),
  setSidebarShortcutAgentKeys: (keys) => set({ sidebarShortcutAgentKeys: keys }),
  requestFocusChatInput: (agentKey) =>
    set((state) => ({
      focusChatInputRequest: {
        id: (state.focusChatInputRequest?.id ?? 0) + 1,
        agentKey,
      },
    })),
  clearFocusChatInputRequest: (id) =>
    set((state) => {
      if (state.focusChatInputRequest?.id !== id) {
        return state;
      }
      return { focusChatInputRequest: null };
    }),
  resetModifiers: () => set({ altDown: false, cmdOrCtrlDown: false }),
}));
