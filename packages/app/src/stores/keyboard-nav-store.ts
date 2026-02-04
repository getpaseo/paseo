import { create } from "zustand";

interface KeyboardNavState {
  commandCenterOpen: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  /** Sidebar-visible agent keys (up to 9), in top-to-bottom visual order. */
  sidebarShortcutAgentKeys: string[];

  setCommandCenterOpen: (open: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setSidebarShortcutAgentKeys: (keys: string[]) => void;
  resetModifiers: () => void;
}

export const useKeyboardNavStore = create<KeyboardNavState>((set) => ({
  commandCenterOpen: false,
  altDown: false,
  cmdOrCtrlDown: false,
  sidebarShortcutAgentKeys: [],

  setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
  setAltDown: (down) => set({ altDown: down }),
  setCmdOrCtrlDown: (down) => set({ cmdOrCtrlDown: down }),
  setSidebarShortcutAgentKeys: (keys) => set({ sidebarShortcutAgentKeys: keys }),
  resetModifiers: () => set({ altDown: false, cmdOrCtrlDown: false }),
}));

