import { create } from "zustand";

type FocusChatInputRequest = {
  id: number;
  agentKey: string;
};

interface KeyboardNavState {
  commandCenterOpen: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  /** Sidebar-visible agent keys (up to 9), in top-to-bottom visual order. */
  sidebarShortcutAgentKeys: string[];

  /**
   * Web-only focus restore element used by the command center. Stored when opening
   * Cmd/Ctrl+K so we can restore focus when closing without navigating.
   */
  focusRestoreElement: HTMLElement | null;
  setFocusRestoreElement: (el: HTMLElement | null) => void;
  takeFocusRestoreElement: () => HTMLElement | null;

  /** Web-only request to focus the MessageInput for the selected agent. */
  focusChatInputRequest: FocusChatInputRequest | null;
  requestFocusChatInput: (agentKey: string) => void;
  clearFocusChatInputRequest: () => void;

  setCommandCenterOpen: (open: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setSidebarShortcutAgentKeys: (keys: string[]) => void;
  resetModifiers: () => void;
}

export const useKeyboardNavStore = create<KeyboardNavState>((set, get) => ({
  commandCenterOpen: false,
  altDown: false,
  cmdOrCtrlDown: false,
  sidebarShortcutAgentKeys: [],

  focusRestoreElement: null,
  setFocusRestoreElement: (el) => set({ focusRestoreElement: el }),
  takeFocusRestoreElement: () => {
    const el = get().focusRestoreElement;
    set({ focusRestoreElement: null });
    return el;
  },

  focusChatInputRequest: null,
  requestFocusChatInput: (agentKey) => {
    const prev = get().focusChatInputRequest;
    const id = (prev?.id ?? 0) + 1;
    set({ focusChatInputRequest: { id, agentKey } });
  },
  clearFocusChatInputRequest: () => set({ focusChatInputRequest: null }),

  setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
  setAltDown: (down) => set({ altDown: down }),
  setCmdOrCtrlDown: (down) => set({ cmdOrCtrlDown: down }),
  setSidebarShortcutAgentKeys: (keys) => set({ sidebarShortcutAgentKeys: keys }),
  resetModifiers: () => set({ altDown: false, cmdOrCtrlDown: false }),
}));
