/**
 * Decides which of the two Live Voice call surfaces is active.
 *
 * The rule: the sidebar card owns the call surface whenever a visible sidebar
 * offers a slot for it; the docked bottom strip is the fallback for every
 * layout where it doesn't (compact, focus mode, collapsed sidebar).
 *
 * Registration rather than layout math on purpose: whether the desktop sidebar
 * is actually visible is decided by `_layout.tsx` from viewport width, panel
 * state, and focus mode. Re-deriving that here would rot; instead the slot that
 * really rendered tells us it exists.
 */

import { useSyncExternalStore } from "react";

let sidebarSlots = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Held by a visible sidebar voice slot for as long as it is on screen. */
export function acquireSidebarVoiceSlot(): () => void {
  sidebarSlots += 1;
  notify();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    sidebarSlots -= 1;
    notify();
  };
}

function getSidebarOwnsSurface(): boolean {
  return sidebarSlots > 0;
}

export function useSidebarOwnsLiveVoiceSurface(): boolean {
  return useSyncExternalStore(subscribe, getSidebarOwnsSurface, getSidebarOwnsSurface);
}
