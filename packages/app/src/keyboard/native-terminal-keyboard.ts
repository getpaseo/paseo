/**
 * Whether a terminal surface currently owns the hardware keyboard on native.
 *
 * The web resolver derives a focus scope from DOM ancestors. Native has no
 * document, so `resolveKeyboardFocusScope` returns "other" for every press and
 * cannot tell the message input from a terminal. A registered `UIKeyCommand` is
 * consumed before the focused surface sees it, so the keys a terminal needs
 * have to be unregistered while it holds focus rather than filtered afterwards.
 * Terminal panes report their own focus here and the iOS command list is
 * rebuilt around it.
 *
 * Claims are keyed rather than counted: panes overlap during a tab switch, and
 * the outgoing pane's cleanup runs after the incoming pane's effect, so a
 * boolean would be cleared by the pane that already lost the keyboard.
 */
const claimedKeys = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Marks a terminal as holding the keyboard until the returned release runs. */
export function claimNativeTerminalKeyboard(key: string): () => void {
  const wasClaimed = claimedKeys.size > 0;
  claimedKeys.add(key);
  if (!wasClaimed) {
    notify();
  }
  return () => {
    if (!claimedKeys.delete(key)) {
      return;
    }
    if (claimedKeys.size === 0) {
      notify();
    }
  };
}

export function isNativeTerminalKeyboardClaimed(): boolean {
  return claimedKeys.size > 0;
}

export function subscribeNativeTerminalKeyboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drops every claim so one case cannot leak into the next. */
export function resetNativeTerminalKeyboardClaims(): void {
  if (claimedKeys.size === 0) {
    return;
  }
  claimedKeys.clear();
  notify();
}
