import { create } from "zustand";
import type { SidebarShortcutWorkspaceTarget } from "@/utils/sidebar-shortcuts";

const SHORTCUT_BADGE_DELAY_MS = 150;

export type CommandCenterScope = "files" | null;

interface KeyboardShortcutsState {
  commandCenterOpen: boolean;
  commandCenterScope: CommandCenterScope;
  shortcutsDialogOpen: boolean;
  capturingShortcut: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  controlShortcutModifierDown: boolean;
  showShortcutBadges: boolean;
  showControlShortcutBadges: boolean;
  /** Sidebar-visible workspace targets (up to 9), in top-to-bottom visual order. */
  sidebarShortcutWorkspaceTargets: SidebarShortcutWorkspaceTarget[];

  setCommandCenterOpen: (open: boolean, scope?: CommandCenterScope) => void;
  setCommandCenterScope: (scope: CommandCenterScope) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setCapturingShortcut: (capturing: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setControlShortcutModifierDown: (down: boolean) => void;
  setSidebarShortcutWorkspaceTargets: (targets: SidebarShortcutWorkspaceTarget[]) => void;
  resetModifiers: () => void;
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null;
let controlBadgeTimer: ReturnType<typeof setTimeout> | null = null;

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

function updateControlBadgeTimer(
  set: (partial: Partial<KeyboardShortcutsState>) => void,
  get: () => KeyboardShortcutsState,
) {
  if (controlBadgeTimer) {
    clearTimeout(controlBadgeTimer);
    controlBadgeTimer = null;
  }

  if (get().controlShortcutModifierDown) {
    controlBadgeTimer = setTimeout(() => {
      set({ showControlShortcutBadges: true });
    }, SHORTCUT_BADGE_DELAY_MS);
  } else {
    set({ showControlShortcutBadges: false });
  }
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set, get) => ({
  commandCenterOpen: false,
  commandCenterScope: null,
  shortcutsDialogOpen: false,
  capturingShortcut: false,
  altDown: false,
  cmdOrCtrlDown: false,
  controlShortcutModifierDown: false,
  showShortcutBadges: false,
  showControlShortcutBadges: false,
  sidebarShortcutWorkspaceTargets: [],

  setCommandCenterOpen: (open, scope = null) =>
    set({ commandCenterOpen: open, commandCenterScope: open ? scope : null }),
  setCommandCenterScope: (scope) => set({ commandCenterScope: scope }),
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
  setControlShortcutModifierDown: (down) => {
    set({ controlShortcutModifierDown: down });
    updateControlBadgeTimer(set, get);
  },
  setSidebarShortcutWorkspaceTargets: (targets) =>
    set({ sidebarShortcutWorkspaceTargets: targets }),
  resetModifiers: () => {
    set({ altDown: false, cmdOrCtrlDown: false, controlShortcutModifierDown: false });
    updateBadgeTimer(set, get);
    updateControlBadgeTimer(set, get);
  },
}));
