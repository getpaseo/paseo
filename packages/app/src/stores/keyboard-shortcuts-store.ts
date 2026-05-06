import { create } from "zustand";
import type { SidebarShortcutWorkspaceTarget } from "@/utils/sidebar-shortcuts";

const SHORTCUT_BADGE_DELAY_MS = 150;

interface KeyboardShortcutsState {
  commandCenterOpen: boolean;
  projectPickerOpen: boolean;
  shortcutsDialogOpen: boolean;
  capturingShortcut: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  showShortcutBadges: boolean;
  /** Sidebar-visible workspace targets (up to 9), in top-to-bottom visual order. */
  sidebarShortcutWorkspaceTargets: SidebarShortcutWorkspaceTarget[];

  setCommandCenterOpen: (open: boolean) => void;
  setProjectPickerOpen: (open: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setCapturingShortcut: (capturing: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setSidebarShortcutWorkspaceTargets: (targets: SidebarShortcutWorkspaceTarget[]) => void;
  resetModifiers: () => void;
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null;

function updateBadgeTimer(
  set: (partial: Partial<KeyboardShortcutsState>) => void,
  get: () => KeyboardShortcutsState,
) {
  const { altDown, cmdOrCtrlDown } = get();
  const modifierDown = altDown || cmdOrCtrlDown;

  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }

  if (modifierDown) {
    badgeTimer = setTimeout(() => {
      set({ showShortcutBadges: true });
    }, SHORTCUT_BADGE_DELAY_MS);
  } else {
    set({ showShortcutBadges: false });
  }
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set, get) => ({
  commandCenterOpen: false,
  projectPickerOpen: false,
  shortcutsDialogOpen: false,
  capturingShortcut: false,
  altDown: false,
  cmdOrCtrlDown: false,
  showShortcutBadges: false,
  sidebarShortcutWorkspaceTargets: [],

  setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
  setProjectPickerOpen: (open) => set({ projectPickerOpen: open }),
  setShortcutsDialogOpen: (open) => set({ shortcutsDialogOpen: open }),
  setCapturingShortcut: (capturing) => set({ capturingShortcut: capturing }),
  setAltDown: (down) => {
    set({ altDown: down });
    updateBadgeTimer(set, get);
  },
  setCmdOrCtrlDown: (down) => {
    set({ cmdOrCtrlDown: down });
    updateBadgeTimer(set, get);
  },
  setSidebarShortcutWorkspaceTargets: (targets) =>
    set({ sidebarShortcutWorkspaceTargets: targets }),
  resetModifiers: () => {
    set({ altDown: false, cmdOrCtrlDown: false });
    updateBadgeTimer(set, get);
  },
}));
