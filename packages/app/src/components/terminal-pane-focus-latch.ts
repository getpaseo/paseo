/**
 * Once-per-pane-focus latch for terminal-pane's focus/reflow effects.
 *
 * Each effect wants to fire exactly once per continuous pane-focus period per terminal, but only
 * while the action can actually land (workspace focused, and for resize claims the app visible —
 * `handleTerminalResize` drops claims emitted while hidden and nothing re-sends them). The latch
 * must therefore record "the action ran", never "we tried": latching before the readiness gate
 * permanently disarms the effect when a pane mounts before its workspace has focus, which is how
 * a terminal ends up rendering full-size while its PTY stays at the daemon's 80x24 default.
 */
export interface FocusLatchStep {
  latchedKey: string | null;
  fire: boolean;
}

export function resolveFocusLatchStep(input: {
  /** Identity of the pane-focus period; null resets the latch (pane blurred, no terminal). */
  key: string | null;
  latchedKey: string | null;
  /** Whether the action can land right now; while false the latch stays untouched. */
  canFire: boolean;
}): FocusLatchStep {
  if (input.key === null) {
    return { latchedKey: null, fire: false };
  }
  if (input.latchedKey === input.key) {
    return { latchedKey: input.latchedKey, fire: false };
  }
  if (!input.canFire) {
    return { latchedKey: input.latchedKey, fire: false };
  }
  return { latchedKey: input.key, fire: true };
}
