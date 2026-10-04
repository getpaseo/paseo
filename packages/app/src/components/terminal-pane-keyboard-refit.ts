// After the keyboard lands the pane's layout settles over a few frames, so one refit is not
// enough: refit immediately, then again at increasing delays, and claim the PTY size last.
export const TERMINAL_KEYBOARD_REFIT_DELAYS_MS = [0, 48, 144, 320];

export interface TerminalKeyboardRefitScheduler {
  /** Cancel any in-flight pulse and start a fresh refit sequence. */
  pulse: () => void;
  cancel: () => void;
}

export function createTerminalKeyboardRefitScheduler<TimerHandle>(input: {
  requestReflow: () => void;
  claimSize: () => void;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}): TerminalKeyboardRefitScheduler {
  let pending: TimerHandle[] = [];

  function cancel(): void {
    for (const handle of pending) {
      input.clearTimeout(handle);
    }
    pending = [];
  }

  function pulse(): void {
    cancel();
    input.requestReflow();
    const lastIndex = TERMINAL_KEYBOARD_REFIT_DELAYS_MS.length - 1;
    pending = TERMINAL_KEYBOARD_REFIT_DELAYS_MS.map((delayMs, index) =>
      input.setTimeout(() => {
        input.requestReflow();
        if (index === lastIndex) {
          pending = [];
          input.claimSize();
        }
      }, delayMs),
    );
  }

  return { pulse, cancel };
}
